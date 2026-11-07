variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "disable_timeout" {
  type    = bool
  default = false
}

variable "etcd_data_cluster_count" {
  description = "Data clusters (three nodes each), named a, b, ..."
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
