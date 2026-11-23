variable "bucket_name" {
  type        = string
  description = "Globally unique bucket name. The caller decides the naming scheme."
}

# Lifecycle settings. Defaults reproduce the original configuration exactly.
variable "tiered_prefix" {
  type        = string
  description = "Prefix whose objects move to Standard-IA and then expire."
  default     = "raw/"
}

variable "ia_transition_days" {
  type        = number
  description = "Days before objects under tiered_prefix move to Standard-IA (minimum 30)."
  default     = 30
}

variable "expiration_days" {
  type        = number
  description = "Days before objects under tiered_prefix expire."
  default     = 90
}

variable "noncurrent_days" {
  type        = number
  description = "Days after an object version becomes noncurrent before it is permanently deleted."
  default     = 30
}
