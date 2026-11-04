variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "disable_timeout" {
  type    = bool
  default = false
}

variable "store_mode" {
  description = "Where game-service keeps games: postgres (config 1, RDS), etcd (config 2, one three-node etcd cluster) or etcd-sharded (config 2 with a control-plane cluster plus data clusters)."
  type        = string
  default     = "postgres"
  validation {
    condition     = contains(["postgres", "etcd", "etcd-sharded"], var.store_mode)
    error_message = "store_mode must be postgres, etcd or etcd-sharded."
  }
}

variable "etcd_data_cluster_count" {
  description = "Data clusters in etcd-sharded mode (three nodes each), named a, b, ..."
  type        = number
  default     = 2
  validation {
    condition     = var.etcd_data_cluster_count >= 1 && var.etcd_data_cluster_count <= 8
    error_message = "etcd_data_cluster_count must be between 1 and 8."
  }
}

variable "etcd_instance_type" {
  type    = string
  default = "t3.small"
}
