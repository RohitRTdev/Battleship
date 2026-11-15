variable "aws_region" { type = string }
variable "name" { type = string }
variable "backend_image" { type = string }

variable "certificate_arn" {
  type    = string
  default = ""
}

variable "rate_limit_enabled" {
  type    = bool
  default = true
}

variable "disable_timeout" {
  type    = bool
  default = false
}
