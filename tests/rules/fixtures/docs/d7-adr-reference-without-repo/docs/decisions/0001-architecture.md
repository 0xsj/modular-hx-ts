# ADR 0001 — Architecture

**Status:** Accepted · **Date:** 2026-08-21

## Context

A fixture needs a decision to record.

## Decision

Hexagonal contexts over a layered shared kernel.

## Alternatives considered

- Vertical slice. Rejected: it is a counterpart (ADR 0099).

## Consequences

Every other blueprint is a delta against this one.

## Enforced by

`S1` · `S2` · `S3` · `S5` · `S6` · `S7` · `S8` · `S9` · `S10` · `M2` · `M13` · `I5` · `M6` ·
`N1` · `N2` · `N3` · `N4` · `N5` · `N6` · `N7` · `D1` · `D2` · `D4` ·
`D5` · `D7` · `R3` · `R4` · `R6` · `R7`

## Verification

The rule suites in `make ci`.
