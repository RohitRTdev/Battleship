variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "disable_timeout" {
  type    = bool
  default = false
}

variable "store_mode" {
  description = "Where game-service keeps games: postgres (config 1, RDS) or etcd (config 2: a control-plane etcd cluster plus data clusters)."
  type        = string
  default     = "postgres"
  validation {
    condition     = contains(["postgres", "etcd"], var.store_mode)
    error_message = "store_mode must be postgres or etcd."
  }
}

variable "etcd_data_cluster_count" {
  description = "Data clusters in etcd mode (three nodes each), named a, b, ..."
  type        = number
  default     = 2
  validation {
    condition     = var.etcd_data_cluster_count >= 1 && var.etcd_data_cluster_count <= 8
    error_message = "etcd_data_cluster_count must be between 1 and 8."
  }
}

variable "etcd_colocate" {
  description = "In etcd mode, run every cluster on the same three machines (each on its own ports) instead of three machines per cluster. Fits accounts with a low vCPU limit, but a machine failure then hits every cluster."
  type        = bool
  default     = false
}

variable "etcd_instance_type" {
  type    = string
  default = "t3.small"
}
