# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/boxuechen/pico8-player/security/advisories/new) for suspected security vulnerabilities. Include the source commit or static-build directory, environment, minimal reproduction and expected impact. Keep credentials, private cartridges and personal data out of the report.

For ordinary compatibility bugs or feature requests, use [Issues](https://github.com/boxuechen/pico8-player/issues).

## Scope

This project is in alpha. Security fixes target the current development branch and current static build; earlier published builds are not maintained. There is no guaranteed response or remediation deadline.

Relevant areas include cartridge parsing, guest execution bounds, WASM/host boundaries, persistence identities and explicitly authorized cartridge I/O. The documented input and instruction limits are implementation boundaries, not a claim that arbitrary guest code is risk-free. Host applications remain responsible for the authority they grant and their own origin, CSP and storage policies.
