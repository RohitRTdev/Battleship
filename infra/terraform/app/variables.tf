variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "rate_limit_enabled" {
  type    = bool
  default = true
}

variable "disable_timeout" {
  type    = bool
  default = false
}
