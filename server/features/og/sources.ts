// Where the preview of a profile gets its numbers. That feature lives in a folder of its own and
// registers its source here (one assignment beside its routes); until then a profile has no card
// of its own.

import type { ProfileInput } from '../../lib/og';
import type { HttpContext } from '../../http/kit';

export interface OgSources {
  /** The public profile of this handle (null: none, or hidden). Young sailors' names come back as "A sailor". */
  profile?: (handle: string, ctx: HttpContext) => Promise<ProfileInput | null>;
}

export const OG_SOURCES: OgSources = {};
