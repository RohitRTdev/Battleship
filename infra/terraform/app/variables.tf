variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "disable_timeout" {
  type    = bool
  default = false
}

variable "store_mode" {
  description = "Where game-service keeps games: postgres (config 1, RDS) or etcd (config 2, three EC2 nodes)."
  type        = string
  default     = "postgres"
  validation {
    condition     = contains(["postgres", "etcd"], var.store_mode)
    error_message = "store_mode must be postgres or etcd."
  }
}

variable "etcd_instance_type" {
  type    = string
  default = "t3.small"
}
