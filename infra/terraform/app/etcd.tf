# Config 2's store: three-node etcd clusters on EC2, each spread over three availability zones.
#   store_mode = "etcd":         one cluster ("main") that serves as both the control plane and the data cluster.
#   store_mode = "etcd-sharded": a control-plane cluster plus etcd_data_cluster_count data clusters (a, b, ...).
# Every node runs the same pinned etcd image as compose.etcd.yaml, with its data on the instance's gp3 root volume.
# Nodes have fixed private IPs, so membership is static.

locals {
  etcd_sharded = var.store_mode == "etcd-sharded"
  etcd_enabled = var.store_mode == "etcd" || local.etcd_sharded
  etcd_image   = "quay.io/coreos/etcd:v3.6.15"
  etcd_azs     = slice(data.aws_availability_zones.available.names, 0, 3)
  # Each cluster takes one IP (10 + its position) in each of the three etcd subnets.
  etcd_clusters = !local.etcd_enabled ? [] : local.etcd_sharded ? concat(
    [{ id = "control", ip_offset = 10 }],
    [for index in range(var.etcd_data_cluster_count) : { id = substr("abcdefgh", index, 1), ip_offset = 11 + index }]
  ) : [{ id = "main", ip_offset = 10 }]
  etcd_nodes = {
    for pair in setproduct(local.etcd_clusters, [1, 2, 3]) : "${pair[0].id}-${pair[1]}" => {
      cluster = pair[0].id
      index   = pair[1]
      ip      = cidrhost(cidrsubnet(aws_vpc.main.cidr_block, 8, 19 + pair[1]), pair[0].ip_offset)
      # The single cluster keeps the member names it has always had.
      name  = local.etcd_sharded ? "${pair[0].id}-${pair[1]}" : "etcd-${pair[1]}"
      token = local.etcd_sharded ? "${var.name}-etcd-${pair[0].id}" : "${var.name}-etcd"
      tag   = local.etcd_sharded ? "${var.name}-etcd-${pair[0].id}-${pair[1]}" : "${var.name}-etcd-${pair[1]}"
    }
  }
  etcd_endpoints = {
    for cluster in local.etcd_clusters : cluster.id => join(",", [for key, node in local.etcd_nodes : "${node.ip}:2379" if node.cluster == cluster.id])
  }
  etcd_members = {
    for cluster in local.etcd_clusters : cluster.id => join(",", [for key, node in local.etcd_nodes : "${node.name}=http://${node.ip}:2380" if node.cluster == cluster.id])
  }
  # What the backends get: the control-plane cluster, and (sharded) the data clusters that seed the registry.
  etcd_control_endpoints = local.etcd_enabled ? local.etcd_endpoints[local.etcd_clusters[0].id] : ""
  etcd_data_clusters     = local.etcd_sharded ? join(";", [for cluster in slice(local.etcd_clusters, 1, length(local.etcd_clusters)) : "${cluster.id}=${local.etcd_endpoints[cluster.id]}"]) : ""
}

# Public subnets: there is no NAT gateway, and the nodes download the etcd image at boot. Only the security
# group below can reach them.
resource "aws_subnet" "etcd" {
  count                   = local.etcd_enabled ? 3 : 0
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.etcd_azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, 20 + count.index)
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.name}-etcd-${count.index + 1}" })
}

resource "aws_route_table_association" "etcd" {
  count          = local.etcd_enabled ? 3 : 0
  subnet_id      = aws_subnet.etcd[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "etcd" {
  count       = local.etcd_enabled ? 1 : 0
  name_prefix = "${var.name}-etcd-"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "etcd clients (game-service, and etcdctl on the nodes themselves)"
    from_port       = 2379
    to_port         = 2379
    protocol        = "tcp"
    security_groups = [aws_security_group.backend.id]
    self            = true
  }
  ingress {
    description = "etcd peers"
    from_port   = 2380
    to_port     = 2380
    protocol    = "tcp"
    self        = true
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
  count              = local.etcd_enabled ? 1 : 0
  name               = "${var.name}-etcd"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "etcd_ssm" {
  count      = local.etcd_enabled ? 1 : 0
  role       = aws_iam_role.etcd[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "etcd" {
  count = local.etcd_enabled ? 1 : 0
  name  = "${var.name}-etcd"
  role  = aws_iam_role.etcd[0].name
  tags  = local.tags
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# The single cluster's nodes were once indexed 0-2; these keep an existing deployment's nodes in place.
moved {
  from = aws_instance.etcd[0]
  to   = aws_instance.etcd["main-1"]
}
moved {
  from = aws_instance.etcd[1]
  to   = aws_instance.etcd["main-2"]
}
moved {
  from = aws_instance.etcd[2]
  to   = aws_instance.etcd["main-3"]
}

resource "aws_instance" "etcd" {
  for_each               = local.etcd_nodes
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.etcd_instance_type
  subnet_id              = aws_subnet.etcd[each.value.index - 1].id
  private_ip             = each.value.ip
  vpc_security_group_ids = [aws_security_group.etcd[0].id]
  iam_instance_profile   = aws_iam_instance_profile.etcd[0].name
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }
  metadata_options { http_tokens = "required" }
  # On first boot this starts a new cluster; afterwards Docker restarts the container and etcd ignores the
  # --initial-* flags because its data directory already exists.
  user_data                   = <<-EOT
    #!/bin/bash
    set -euo pipefail
    dnf install -y docker
    systemctl enable --now docker
    mkdir -p /var/lib/etcd
    docker run --detach --restart always --name etcd --network host -v /var/lib/etcd:/var/lib/etcd ${local.etcd_image} \
      etcd --name ${each.value.name} --data-dir /var/lib/etcd \
      --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://${each.value.ip}:2379 \
      --listen-peer-urls http://0.0.0.0:2380 --initial-advertise-peer-urls http://${each.value.ip}:2380 \
      --initial-cluster ${local.etcd_members[each.value.cluster]} --initial-cluster-state new --initial-cluster-token ${each.value.token} \
      --auto-compaction-mode periodic --auto-compaction-retention 1h
  EOT
  user_data_replace_on_change = true
  tags                        = merge(local.tags, { Name = each.value.tag, EtcdCluster = each.value.cluster })
}

output "etcd_endpoints" {
  description = "The control-plane etcd cluster (in etcd mode, also the one data cluster)."
  value       = local.etcd_control_endpoints
}

output "etcd_data_clusters" {
  description = "The data clusters the registry was seeded with (etcd-sharded mode)."
  value       = local.etcd_data_clusters
}
