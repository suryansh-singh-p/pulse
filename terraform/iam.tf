# Least-privilege access for the pulse api/worker. Everything not allowed here is denied.
# In production this policy would be attached to an IAM role assumed through IRSA,
# not to a user with access keys.
data "aws_iam_policy_document" "pulse_app" {
  # Raw events: write and read back.
  statement {
    sid       = "RawReadWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${module.events_bucket.arn}/raw/*"]
  }

  # Reports: write only.
  statement {
    sid       = "ReportsWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.events_bucket.arn}/reports/*"]
  }

  # Listing applies to the bucket ARN itself (no /...), limited to the two prefixes.
  statement {
    sid       = "ListOwnPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [module.events_bucket.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["raw/*", "reports/*"]
    }
  }
}

resource "aws_iam_policy" "pulse_app" {
  name        = "pulse-app-s3-${var.env}"
  description = "pulse app: read/write raw/, write reports/, list those prefixes in ${module.events_bucket.bucket}"
  policy      = data.aws_iam_policy_document.pulse_app.json
}

resource "aws_iam_user" "pulse_app" {
  name = "pulse-app"
}

resource "aws_iam_user_policy_attachment" "pulse_app" {
  user       = aws_iam_user.pulse_app.name
  policy_arn = aws_iam_policy.pulse_app.arn
}

# The access key is deliberately NOT created here: aws_iam_access_key would store the
# secret in Terraform state. Create it with the CLI after apply (see Part 4/6).
