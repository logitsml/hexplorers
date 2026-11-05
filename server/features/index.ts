// The server's features beyond the room and guests (accounts, friends, safety, push, ratings, link
// previews), each in a folder of its own
// under server/features and listed once in FEATURES below. A feature brings its own tables, its own
// routes, what it turns on in /api/config, and hooks into the services the rooms call (a hook wraps
// the method it replaces, so features compose: accounts wraps identify, ratings wraps finishGame).
// Nothing here may import a platform API (see server/core/ports.ts).

import type { FeatureFlags } from '../../src/net/protocol';
import type { RandomBytes } from '../../src/net/codes';
import type { BlobStore, ServerEnv, ServiceDb } from '../core/ports';
import type { Route } from '../http/kit';
import type { RoomDirectory, Services } from '../services';
import { accounts } from './accounts';
import { friends } from './friends';
import { safety } from './safety';
import { push } from './push';
import { og } from './og';
import { ratings } from './ratings';

export interface FeatureDeps {
  db: ServiceDb;
  blobs: BlobStore;
  env: ServerEnv;
  rooms: RoomDirectory;
  now: () => number;
  random: RandomBytes;
}

export interface Feature {
  id: string;
  /** CREATE TABLE / CREATE INDEX statements for the service database (each IF NOT EXISTS). */
  schema?: string[];
  /** HTTP routes; matched ahead of the planned placeholders. */
  routes?: Route[];
  /** What this feature turns on in /api/config (off until keyed: look at env). */
  flags?(env: ServerEnv): Partial<FeatureFlags>;
  /** Extra public config for the client (e.g. a client id), merged into /api/config. */
  config?(env: ServerEnv): Record<string, unknown>;
  /** Wrap or add service methods: called once when the services are made, in FEATURES order. */
  extend?(services: Services, deps: FeatureDeps): void;
}

/** Every feature, in the order their hooks wrap the services. Add yours with one line. */
export const FEATURES: Feature[] = [accounts, friends, safety, ratings, push, og];

export const featureSchema = () => FEATURES.flatMap((f) => f.schema ?? []);
export const featureRoutes = () => FEATURES.flatMap((f) => f.routes ?? []);
export const featureFlags = (env: ServerEnv) => Object.assign({}, ...FEATURES.map((f) => f.flags?.(env) ?? {})) as Partial<FeatureFlags>;
export const featureConfig = (env: ServerEnv) => Object.assign({}, ...FEATURES.map((f) => f.config?.(env) ?? {})) as Record<string, unknown>;
export function extendServices(services: Services, deps: FeatureDeps) {
  for (const f of FEATURES) f.extend?.(services, deps);
}
