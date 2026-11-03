variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "disable_timeout" {
  type = bool
  default = false
}
