output "bucket_name" {
  description = "Name of the events bucket (use with: terraform output -raw bucket_name)."
  value       = module.events_bucket.bucket
}

output "bucket_arn" {
  description = "ARN of the events bucket, for policies that need to reference it."
  value       = module.events_bucket.arn
}

output "pulse_app_user_arn" {
  description = "ARN of the pulse-app IAM user; should match get-caller-identity with the pulse-app profile."
  value       = aws_iam_user.pulse_app.arn
}
