# Security

The CLI lists object metadata using local credentials. It does not send telemetry, read payloads, or mutate cloud objects. The selected AWS credential chain may contact AWS identity services before listing. R2 uses the explicitly configured R2 credentials.

Checkpoints and exports contain customer identifiers and usage. Keep them out of public repositories and issue reports. The CLI protects newly created files with restrictive permissions where the operating system supports them.

Use short-lived AWS credentials and bucket-scoped R2 tokens where possible. The code never needs `s3:GetObject` or write/delete permissions. SDK endpoint overrides in your environment can change AWS request destinations; review your environment before using production credentials.

Before public release, the maintainer must configure GitHub private vulnerability reporting or publish a monitored security contact. That contact is not yet configured in this local checkout. Do not post vulnerabilities containing credentials or customer data publicly.

Only the latest CLI release will be supported initially. No hosted service or billing correctness guarantee is included in this package.
