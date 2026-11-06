mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b", "ap-south-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_vpc" {
    defaults = { cidr_block = "10.42.0.0/16" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/mock/0123456789abcdef" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/mock/0123456789abcdef" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:db" }] }
  }
}

variables {
  aws_region    = "ap-south-1"
  name          = "battleship-test"
  backend_image = "example/backend:test"
}

run "postgres_mode" {
  command = apply
  variables { store_mode = "postgres" }
  assert {
    condition     = length(aws_db_instance.main) == 1 && length(aws_instance.etcd) == 0
    error_message = "postgres mode should create RDS and no etcd nodes"
  }
  assert {
    condition     = strcontains(aws_ecs_task_definition.backend.container_definitions, "PGHOST") && !strcontains(aws_ecs_task_definition.backend.container_definitions, "ETCD_ENDPOINTS")
    error_message = "postgres mode should pass PG* settings, not etcd endpoints"
  }
}

run "etcd_mode" {
  command = apply
  variables { store_mode = "etcd" }
  assert {
    condition     = length(aws_db_instance.main) == 0 && length(aws_instance.etcd) == 9
    error_message = "etcd mode should create a control plane and two data clusters of three nodes each, and no RDS"
  }
  assert {
    condition = { for key, node in aws_instance.etcd : key => node.private_ip } == {
      "control-1" = "10.42.20.10", "control-2" = "10.42.21.10", "control-3" = "10.42.22.10",
      "a-1"       = "10.42.20.11", "a-2" = "10.42.21.11", "a-3" = "10.42.22.11",
      "b-1"       = "10.42.20.12", "b-2" = "10.42.21.12", "b-3" = "10.42.22.12"
    }
    error_message = "each cluster should take one IP per etcd subnet"
  }
  assert {
    condition = strcontains(aws_instance.etcd["a-2"].user_data,
    "--initial-cluster a-1=http://10.42.20.11:2380,a-2=http://10.42.21.11:2380,a-3=http://10.42.22.11:2380 --initial-cluster-state new --initial-cluster-token battleship-test-etcd-a ")
    error_message = "a data cluster's nodes should form their own cluster"
  }
  assert {
    condition = alltrue([
      strcontains(aws_ecs_task_definition.backend.container_definitions, "\"name\":\"STORE_MODE\",\"value\":\"etcd\""),
      strcontains(aws_ecs_task_definition.backend.container_definitions, "10.42.20.10:2379,10.42.21.10:2379,10.42.22.10:2379"),
      strcontains(aws_ecs_task_definition.backend.container_definitions, "a=10.42.20.11:2379,10.42.21.11:2379,10.42.22.11:2379;b=10.42.20.12:2379,10.42.21.12:2379,10.42.22.12:2379"),
      !strcontains(aws_ecs_task_definition.backend.container_definitions, "PGHOST")
    ])
    error_message = "the backend should get STORE_MODE=etcd, the control plane and both data clusters"
  }
  assert {
    condition     = aws_ecs_service.backend.enable_execute_command
    error_message = "ECS Exec should be on, so the cluster CLI can run in a task"
  }
}

run "etcd_mode_with_three_data_clusters" {
  command = plan
  variables {
    store_mode              = "etcd"
    etcd_data_cluster_count = 3
  }
  assert {
    condition     = length(aws_instance.etcd) == 12 && contains(keys(aws_instance.etcd), "c-3")
    error_message = "three data clusters should add c-1..3"
  }
}

run "etcd_mode_colocated" {
  command = apply
  variables {
    store_mode    = "etcd"
    etcd_colocate = true
  }
  assert {
    condition = { for key, node in aws_instance.etcd : key => node.private_ip } == {
      "shared-1" = "10.42.20.10", "shared-2" = "10.42.21.10", "shared-3" = "10.42.22.10"
    }
    error_message = "co-located clusters should share three machines"
  }
  assert {
    condition = alltrue([
      strcontains(aws_instance.etcd["shared-2"].user_data, "--name control-2 --data-dir /var/lib/etcd-control "),
      strcontains(aws_instance.etcd["shared-2"].user_data, "--initial-cluster a-1=http://10.42.20.10:2382,a-2=http://10.42.21.10:2382,a-3=http://10.42.22.10:2382 "),
      strcontains(aws_instance.etcd["shared-2"].user_data, "--name etcd-b --network host -v /var/lib/etcd-b:/var/lib/etcd-b "),
      strcontains(aws_instance.etcd["shared-2"].user_data, "--advertise-client-urls http://10.42.21.10:2383 ")
    ])
    error_message = "each machine should run one member of every cluster, each cluster on its own ports"
  }
  assert {
    condition     = strcontains(aws_ecs_task_definition.backend.container_definitions, "a=10.42.20.10:2381,10.42.21.10:2381,10.42.22.10:2381;b=10.42.20.10:2383,10.42.21.10:2383,10.42.22.10:2383")
    error_message = "the backend should get each data cluster on its own port"
  }
  assert {
    condition     = length(aws_security_group.etcd[0].ingress) == 6
    error_message = "every cluster's client and peer port should be open"
  }
}

run "rejects_unknown_mode" {
  command = plan
  variables { store_mode = "valkey" }
  expect_failures = [var.store_mode]
}
