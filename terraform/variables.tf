variable "region" {
  type        = string
  description = "AWS region for all resources."
}

variable "env" {
  type        = string
  description = "Environment name, used in resource names and tags."

  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "The env variable must be \"dev\" or \"prod\"."
  }
}

variable "bucket_prefix" {
  type        = string
  description = "Start of the events bucket name; env and account ID are appended to make it globally unique."
}

variable "owner" {
  type        = string
  description = "Who owns these resources, used in the owner tag."
}
