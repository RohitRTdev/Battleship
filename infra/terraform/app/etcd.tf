# Three shared EC2 hosts, one per availability zone. Each runs one member of every etcd cluster.
# Clusters use separate ports and data directories on each host.
locals {
  etcd_image       = "quay.io/coreos/etcd:v3.6.15"
  etcd_azs         = slice(data.aws_availability_zones.available.names, 0, 3)
  etcd_cluster_ids = concat(["control"], [for index in range(var.etcd_data_cluster_count) : substr("abcdefgh", index, 1)])
  etcd_clusters = [for position, id in local.etcd_cluster_ids : {
    id          = id
    client_port = 2379 + 2 * position
    peer_port   = 2380 + 2 * position
  }]
  etcd_nodes = {
    for pair in setproduct(local.etcd_clusters, [1, 2, 3]) : "${pair[0].id}-${pair[1]}" => {
      cluster     = pair[0].id
      index       = pair[1]
      ip          = cidrhost(cidrsubnet(aws_vpc.main.cidr_block, 8, 19 + pair[1]), 10)
      client_port = pair[0].client_port
      peer_port   = pair[0].peer_port
      name        = "${pair[0].id}-${pair[1]}"
      token       = "${var.name}-etcd-${pair[0].id}"
      container   = "etcd-${pair[0].id}"
      data_dir    = "/var/lib/etcd-${pair[0].id}"
    }
  }
  etcd_hosts = {
    for index in [1, 2, 3] : "shared-${index}" => {
      index   = index
      ip      = local.etcd_nodes["control-${index}"].ip
      tag     = "${var.name}-etcd-shared-${index}"
      cluster = "shared"
      members = [for key, node in local.etcd_nodes : node if node.index == index]
    }
  }
  etcd_client_ports = distinct([for cluster in local.etcd_clusters : cluster.client_port])
  etcd_peer_ports   = distinct([for cluster in local.etcd_clusters : cluster.peer_port])
  etcd_endpoints = {
    for cluster in local.etcd_clusters : cluster.id => join(",", [for key, node in local.etcd_nodes : "${node.ip}:${node.client_port}" if node.cluster == cluster.id])
  }
  etcd_members = {
    for cluster in local.etcd_clusters : cluster.id => join(",", [for key, node in local.etcd_nodes : "${node.name}=http://${node.ip}:${node.peer_port}" if node.cluster == cluster.id])
  }
  # What the backends get: the control-plane cluster, and the data clusters that seed the registry.
  etcd_control_endpoints = local.etcd_endpoints[local.etcd_clusters[0].id]
  etcd_data_clusters     = join(";", [for cluster in slice(local.etcd_clusters, 1, length(local.etcd_clusters)) : "${cluster.id}=${local.etcd_endpoints[cluster.id]}"])
}

# Public subnets: there is no NAT gateway, and the nodes download the etcd image at boot. Only the security
# group below can reach them.
resource "aws_subnet" "etcd" {
  count                   = 3
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.etcd_azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, 20 + count.index)
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.name}-etcd-${count.index + 1}" })
}

resource "aws_route_table_association" "etcd" {
  count          = 3
  subnet_id      = aws_subnet.etcd[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "etcd" {
  name_prefix = "${var.name}-etcd-"
  vpc_id      = aws_vpc.main.id
  dynamic "ingress" {
    for_each = local.etcd_client_ports
    content {
      description     = "etcd clients (game-service, and etcdctl on the nodes themselves)"
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      security_groups = [aws_security_group.backend.id]
      self            = true
    }
  }
  dynamic "ingress" {
    for_each = local.etcd_peer_ports
    content {
      description = "etcd peers"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      self        = true
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

# No SSH: shell access (for example, to stop a node in a failover experiment) is through SSM Session Manager.
resource "aws_iam_role" "etcd" {
  name               = "${var.name}-etcd"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "etcd_ssm" {
  role       = aws_iam_role.etcd.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "etcd" {
  name = "${var.name}-etcd"
  role = aws_iam_role.etcd.name
  tags = local.tags
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "etcd" {
  for_each               = local.etcd_hosts
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.etcd_instance_type
  subnet_id              = aws_subnet.etcd[each.value.index - 1].id
  private_ip             = each.value.ip
  vpc_security_group_ids = [aws_security_group.etcd.id]
  iam_instance_profile   = aws_iam_instance_profile.etcd.name
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }
  metadata_options { http_tokens = "required" }
  # On first boot this starts each etcd member on the machine as a new cluster; afterwards Docker restarts the
  # containers and etcd ignores the --initial-* flags because its data directory already exists.
  user_data                   = <<-EOT
    #!/bin/bash
    set -euo pipefail
    dnf install -y docker
    systemctl enable --now docker
    %{for node in each.value.members~}
    mkdir -p ${node.data_dir}
    docker run --detach --restart always --name ${node.container} --network host -v ${node.data_dir}:${node.data_dir} ${local.etcd_image} \
      etcd --name ${node.name} --data-dir ${node.data_dir} \
      --listen-client-urls http://0.0.0.0:${node.client_port} --advertise-client-urls http://${node.ip}:${node.client_port} \
      --listen-peer-urls http://0.0.0.0:${node.peer_port} --initial-advertise-peer-urls http://${node.ip}:${node.peer_port} \
      --initial-cluster ${local.etcd_members[node.cluster]} --initial-cluster-state new --initial-cluster-token ${node.token} \
      --auto-compaction-mode periodic --auto-compaction-retention 1h
    %{endfor~}
  EOT
  user_data_replace_on_change = true
  tags                        = merge(local.tags, { Name = each.value.tag, EtcdCluster = each.value.cluster })
}

output "etcd_endpoints" {
  description = "The control-plane etcd cluster."
  value       = local.etcd_control_endpoints
}

output "etcd_data_clusters" {
  description = "The data clusters the registry was seeded with."
  value       = local.etcd_data_clusters
}
