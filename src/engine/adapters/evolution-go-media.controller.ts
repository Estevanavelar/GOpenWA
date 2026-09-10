/**
 * Serves the outbound blobs {@link EvolutionGoMediaHost} hosts, at the URL that host mints.
 *
 * @Public is the correct fence here and it is not a convenience: the caller is the Evolution Go
 * container, which has no API key and cannot be given one — the fetch happens inside the service's own
 * send call. The authorization is the signed, expiring token in the path, which is why the route carries
 * no key requirement and why the token is the ONLY thing this controller trusts.
 *
 * There is deliberately no cleanup route. Nothing about a GET would authorize a delete, and an
 * unauthenticated @Public surface in front of the store is a worse thing to own than a stale blob:
 * eviction is {@link EvolutionGoMediaHost.sweepExpired}, which only this application can reach.
 */

import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { isMissingObjectError, StorageService } from '../../common/storage/storage.service';
import { Public } from '../../modules/auth/decorators/auth.decorators';
import { EVOLUTION_GO_MEDIA_ROUTE, EvolutionGoMediaHost } from './evolution-go-media-host';

/** Longest filename echoed into the header. The name is informational here, never a path. */
const MAX_HEADER_FILENAME_CHARS = 200;

/** Used when sanitising leaves nothing to send — every HTTP client tolerates this name. */
const FALLBACK_FILENAME = 'media';

/**
 * The single answer to every refusal on this route: unknown token, tampered token, expired token, and a
 * blob that is no longer there. Deliberately identical, because the caller is the engine service and the
 * distinction is only useful to someone probing the route.
 */
const NOT_FOUND_DETAIL = 'No media at this URL. The link is invalid or has expired.';

/**
 * Reduce a caller-supplied filename to something safe inside a quoted header parameter.
 *
 * Four things can go wrong with the raw name, and all four come from the REST request that hosted the
 * media: a `"` ends the quoted value early, a `\` escapes the character after it in some parsers, CR/LF
 * is header injection, and ANY non-latin1 byte makes Node's `res.set` throw ERR_INVALID_CHAR — turning a
 * perfectly valid URL into a 500 for a file named in Japanese. Keeping printable ASCII closes all four at
 * once, and nothing downstream depends on the name surviving verbatim: the send body carries the real
 * filename, and this header is informational.
 */
function headerFilename(filename: string): string {
  const cleaned = filename
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\//g, '_')
    .trim()
    .slice(0, MAX_HEADER_FILENAME_CHARS)
    // Truncation can leave a trailing space where the cut landed.
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_FILENAME;
}

@ApiTags('engine')
@Public()
@Controller(EVOLUTION_GO_MEDIA_ROUTE)
export class EvolutionGoMediaController {
  constructor(
    private readonly mediaHost: EvolutionGoMediaHost,
    private readonly storage: StorageService,
  ) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Fetch media hosted for the Evolution Go engine',
    description:
      'Serves a blob an outbound media send hosted for the engine service to download. Authorized by the ' +
      'signed token in the path — this route requires no API key, because the caller is the engine ' +
      'container itself.',
  })
  @ApiParam({ name: 'token', description: 'Signed, expiring token minted when the media was hosted', type: String })
  @ApiResponse({
    status: 200,
    description: 'The stored bytes, with the mimetype and filename the send recorded',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 404, description: 'The token is invalid, tampered, expired, or its blob is gone' })
  async fetch(@Param('token') token: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    // One null covers every rejection — malformed, wrong signature, unknown version, expired — so this
    // handler cannot report WHICH part failed and a forger learns nothing from the answer. 404 rather
    // than 401/403: the caller presents no credential here, and an auth-shaped status would suggest one
    // exists to be presented.
    const descriptor = this.mediaHost.readToken(token);
    if (!descriptor) throw new NotFoundException(NOT_FOUND_DETAIL);

    let bytes: Buffer;
    try {
      bytes = await this.storage.getFile(descriptor.storageKey);
    } catch (error) {
      // A blob that was swept or never written is the same answer as an expired token: the URL no longer
      // resolves. A storage backend that is DOWN is not, and is rethrown as a 500 — folding an outage
      // into a 404 would send the engine's operator hunting for a bad link that is actually fine.
      if (isMissingObjectError(error)) throw new NotFoundException(NOT_FOUND_DETAIL);
      throw error;
    }

    res.set({
      // Already reduced to a safe header value when the token was minted (see the host's
      // normalizeMimetype): this route echoes a value the REST caller supplied, so it is normalized once,
      // where it enters, rather than defensively at every exit.
      'Content-Type': descriptor.mimetype,
      // The engine downloads this; nosniff costs nothing and means a mimetype mistake can never be
      // re-interpreted as active content on the API origin.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${headerFilename(descriptor.filename)}"`,
    });
    return new StreamableFile(bytes);
  }
}
