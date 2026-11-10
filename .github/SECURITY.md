
# Security Policy

## Overview

Security is a core priority for Coloride.

Coloride is an open-source, local-first AI code editor built with Rust, Tauri, and TypeScript.

We take security vulnerabilities seriously, particularly those involving code execution, sandbox isolation, filesystem access, and AI-assisted operations.

## Supported Versions

Coloride is currently under active development.

Until the first stable release, security fixes are generally applied to the latest development version.

| Version | Supported |
| ------- | --------- |
| main (development) | Yes |
| Older commits | No guaranteed support |

## Reporting a Vulnerability

Please do not disclose security vulnerabilities through public GitHub Issues or Discussions.

Instead, use GitHub's private vulnerability reporting feature:

https://github.com/Color-IDE/Coloride/security/advisories/new

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Affected components and versions
- Potential security impact
- A proof of concept, if available

## Security Principles

Coloride follows these principles:

- Local-first architecture
- Explicit authorization of AI-generated operations
- Fail-closed sandbox isolation
- Workspace trust boundaries
- Least-privilege access
- Validation before applying AI-generated changes

## Disclosure

We aim to review security reports and coordinate responsible disclosure.

Response and resolution times may vary depending on severity and available maintenance resources.

Please allow the maintainers an opportunity to investigate before publicly disclosing a vulnerability.

## Maintainers

Security reports are handled by the Coloride maintainers.

Project: https://github.com/Color-IDE/Coloride
