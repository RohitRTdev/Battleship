# Config 2's store: a three-node etcd cluster, one EC2 instance per availability zone, created only when
# store_mode = "etcd". Each node runs the same pinned etcd image as compose.etcd.yaml, with its data on the
# instance's gp3 root volume. Nodes have fixed private IPs, so membership is static.

locals {
  etcd_enabled = var.store_mode == "etcd"
  etcd_count   = local.etcd_enabled ? 3 : 0
  etcd_image   = "quay.io/coreos/etcd:v3.6.15"
  etcd_azs     = slice(data.aws_availability_zones.available.names, 0, 3)
  etcd_ips     = [for index in range(3) : cidrhost(cidrsubnet(aws_vpc.main.cidr_block, 8, 20 + index), 10)]
  etcd_cluster = join(",", [for index, ip in local.etcd_ips : "etcd-${index + 1}=http://${ip}:2380"])
}

# Public subnets: there is no NAT gateway, and the nodes download the etcd image at boot. Only the security
# group below can reach them.
resource "aws_subnet" "etcd" {
  count                   = local.etcd_count
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.etcd_azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, 20 + count.index)
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.name}-etcd-${count.index + 1}" })
}

resource "aws_route_table_association" "etcd" {
  count          = local.etcd_count
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

resource "aws_instance" "etcd" {
  count                  = local.etcd_count
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.etcd_instance_type
  subnet_id              = aws_subnet.etcd[count.index].id
  private_ip             = local.etcd_ips[count.index]
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
      etcd --name etcd-${count.index + 1} --data-dir /var/lib/etcd \
      --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://${local.etcd_ips[count.index]}:2379 \
      --listen-peer-urls http://0.0.0.0:2380 --initial-advertise-peer-urls http://${local.etcd_ips[count.index]}:2380 \
      --initial-cluster ${local.etcd_cluster} --initial-cluster-state new --initial-cluster-token ${var.name}-etcd \
      --auto-compaction-mode periodic --auto-compaction-retention 1h
  EOT
  user_data_replace_on_change = true
  tags                        = merge(local.tags, { Name = "${var.name}-etcd-${count.index + 1}" })
}

output "etcd_endpoints" {
  value = local.etcd_enabled ? join(",", [for ip in local.etcd_ips : "${ip}:2379"]) : ""
}
