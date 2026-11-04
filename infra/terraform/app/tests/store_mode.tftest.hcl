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
    condition     = length(aws_db_instance.main) == 0 && length(aws_instance.etcd) == 3
    error_message = "etcd mode should create three etcd nodes and no RDS"
  }
  assert {
    condition     = [for node in aws_instance.etcd : node.private_ip] == ["10.42.20.10", "10.42.21.10", "10.42.22.10"]
    error_message = "etcd nodes should have the fixed private IPs"
  }
  assert {
    condition     = strcontains(aws_ecs_task_definition.backend.container_definitions, "10.42.20.10:2379,10.42.21.10:2379,10.42.22.10:2379") && !strcontains(aws_ecs_task_definition.backend.container_definitions, "PGHOST")
    error_message = "etcd mode should pass the etcd endpoints and no PG* settings"
  }
}

run "rejects_unknown_mode" {
  command         = plan
  variables { store_mode = "valkey" }
  expect_failures = [var.store_mode]
}
