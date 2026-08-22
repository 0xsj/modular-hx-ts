/**
 * The logger contract suite. **Test tooling** — rule `S3` keeps it out of
 * shipping code.
 *
 * Rule `M1` says a module with more than one implementation has **one** suite
 * that every implementation passes. Every repository read that as "L2, the
 * first module with two adapters" — reasonable, and too narrow. The test is not
 * whether implementations are interchangeable *backends*; it is whether they
 * must **agree observably**. `logger` qualifies: console renders for a human
 * and JSON for a collector, so they differ in **format** and never in **fields**.
 *
 * So this asserts a **field set**, not bytes. Each adapter supplies a way to
 * recover the fields it emitted, and the four cases below must produce the same
 * set from every one of them.
 *
 * The record shape itself is `../../../MODULES.md` §2, and the field names are
 * normative — conformance case 54 checks them byte-identically across every
 * blueprint, because if one emits `err_kind` and another `error_kind`, both
 * repos' own suites pass and the collection has silently drifted.
 */

import { expect, it } from 'vitest';
import { type Clock } from '../clock/index.js';
import { notFound } from '../errors/index.js';
import { fakeIds } from '../id/index.js';
import { Actor, Carrier, makeOrigins } from '../provenance/index.js';
import { unwrap } from '../result/index.js';
import { type Logger } from './logger.js';

/**
 * An adapter under test: build a logger, and recover what it emitted.
 *
 * `emitted` returns one record's fields as a flat map. How it gets there is the
 * adapter's business — parsing a line, reading a buffer — which is exactly the
 * difference the suite exists to see past.
 */
export interface LoggerUnderTest {
  readonly name: string;
  build(clock: Clock): Logger;
  emitted(): readonly Readonly<Record<string, unknown>>[];
}

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const USER = '01a024c7-d2d6-7e71-8c87-e344e27ef844';

/**
 * Recover the fields from a console line.
 *
 * `time`, `level` and `msg` are positional; everything after the first double
 * space is `key=value`. Parsing it back is itself worth asserting: a human
 * format nobody can machine-read is one that quietly stops carrying what it
 * claims.
 *
 * The level is padded to a fixed width so messages align, which means `INFO `
 * plus its separator is already a double space — so the message and the pairs
 * are split *after* the two positional tokens, never by scanning the whole
 * line. Getting that wrong reads the message as the field list, which is how
 * this parser failed the first time it ran.
 */
export function parseConsoleLine(
  line: string,
): Readonly<Record<string, unknown>> {
  const [head = '', ...stack] = line.split('\n');

  const positional = /^(\S+)\s+(\S+)\s+(.*)$/.exec(head);
  if (positional === null) return {};

  const [, time = '', level = '', remainder = ''] = positional;
  const boundary = remainder.indexOf('  ');
  const msg = boundary === -1 ? remainder : remainder.slice(0, boundary);
  const pairs = boundary === -1 ? '' : remainder.slice(boundary + 2);

  const fields: Record<string, unknown> = {
    time,
    level: level.toLowerCase(),
    msg,
  };

  // Values are quoted only when ambiguous, so a quoted one may contain spaces:
  // `error="no user with that id"`. Splitting on spaces tears that apart, which
  // is the second way this parser failed.
  const PAIR = /([\w.]+)=("(?:[^"\\]|\\.)*"|\S*)/g;

  for (const [, key = '', raw = ''] of pairs.matchAll(PAIR)) {
    fields[key] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  }

  if (stack.length > 0) fields['__stack'] = stack.join('\n');
  return fields;
}

/** Field names only, sorted — what "agree observably" means here. */
const namesOf = (fields: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(fields)
    .filter((key) => !key.startsWith('__'))
    .sort();

/**
 * The four cases every adapter must agree on.
 *
 * Called once per adapter from that adapter's test file, which is what makes it
 * one suite rather than three similar ones.
 */
export function loggerContract(
  adapter: () => LoggerUnderTest,
  clock: () => Clock,
): void {
  const withProvenance = <T>(fn: () => T): T => {
    const provenance = makeOrigins(fakeIds(clock()))
      .forRequest({ correlationId: 'corr_7f3a', traceparent: TRACEPARENT })
      .withActor(unwrap(Actor.user(USER)))
      .withTenant('acme');

    return Carrier.run(provenance, fn);
  };

  it(`${adapter().name}: a plain message carries time, level and msg`, () => {
    const under = adapter();
    under.build(clock()).info('user registered');

    const [record] = under.emitted();
    expect(namesOf(record ?? {})).toEqual(['level', 'msg', 'time']);
    expect(record?.['level']).toBe('info');
    expect(record?.['msg']).toBe('user registered');
  });

  it(`${adapter().name}: an error carries error and err_kind`, () => {
    const under = adapter();
    under.build(clock()).error('request failed', {
      err: notFound('no user with that id'),
    });

    const [record] = under.emitted();
    expect(namesOf(record ?? {})).toEqual([
      'err_kind',
      'error',
      'level',
      'msg',
      'time',
    ]);
    expect(record?.['error']).toBe('no user with that id');
    // Conformance 50: a Kind, never a free-form string.
    expect(record?.['err_kind']).toBe('not_found');
  });

  it(`${adapter().name}: full provenance carries every join key`, () => {
    const under = adapter();
    withProvenance(() => {
      under.build(clock()).info('user registered');
    });

    const [record] = under.emitted();
    expect(namesOf(record ?? {})).toEqual([
      'actor',
      'correlation_id',
      'level',
      'msg',
      'request_id',
      'tenant',
      'time',
      'trace_id',
    ]);
    expect(record?.['actor']).toBe(`user:${USER}`);
    expect(record?.['correlation_id']).toBe('corr_7f3a');
    // Conformance 52: trace_id derives from the traceparent, never appears
    // without one, and is the trace id rather than the whole header.
    expect(record?.['trace_id']).toBe(TRACE_ID);
  });

  it(`${adapter().name}: no provenance omits its fields entirely`, () => {
    // Conformance 51: absent fields are omitted, not emitted empty. A line
    // carries what is true rather than a row of empty strings.
    const under = adapter();
    under.build(clock()).info('no scope here');

    const [record] = under.emitted();
    for (const absent of [
      'request_id',
      'correlation_id',
      'causation_id',
      'actor',
      'tenant',
      'trace_id',
    ]) {
      expect(namesOf(record ?? {})).not.toContain(absent);
    }
  });
}
