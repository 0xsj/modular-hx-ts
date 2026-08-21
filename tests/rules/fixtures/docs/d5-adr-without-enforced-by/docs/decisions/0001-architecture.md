# ADR 0001 — Architecture

**Status:** Accepted · **Date:** 2026-08-21

## Context

A fixture needs a decision to record.

## Decision

Hexagonal contexts over a layered shared kernel.

## Alternatives considered

- Vertical slice. Rejected: it is a counterpart.

## Consequences

Every other blueprint is a delta against this one.

## Verification

The rule suites in `make ci`.
