// World-space radar/sonar contacts.
//
// A contact-only enemy is not the real entity and must not be drawn as one, so
// it gets a generic blip: no blueprint, no body dimensions, no team colour, no
// selection. See budget_design_philosophy.html "Sight, radar, sonar, and
// contacts are separate information tiers".
//
// Beyond All Reason jitters its radar icons by a sine of game time so a contact
// reads as uncertain. We deliberately do not: a shimmering blip is
// indistinguishable from a moving one, and a contact that has come to a stop has
// to read as stopped. Uncertainty is carried by what the blip withholds and by
// its reduced alpha, never by moving it away from where the return was heard.
//
// Contact membership arrives on filtered presentation snapshots, but position
// does not own a second radar clock. The anonymous id is resolved through the
// exact adjacent-fixed-tick pose and render alpha used by the visible model.
// The renderer retains membership and fade only: no contact pose, endpoints,
// or inferred velocity. Blips and models share the one in/out duration pair
// from visionConfig.json, so a tier transition is a co-located cross-fade.
//
// The extension is the medium and the third spatial coordinate. Each contact
// carries the lane that earned it plus its observed world-space altitude, so an
// aircraft return stays in the air and a submerged return stays underwater. A
// straddling target independently covered in both lanes has a distinct dual
// treatment. The contact remains anonymous: no blueprint, owner, health, or
// body shape crosses this information tier.

import * as THREE from 'three';
import { COLORS } from '../../colorsConfig';
import type { MinimapEntity } from '@/types/ui';
import type { ViewportFootprint } from '../ViewportFootprint';
import {
  CONTACT_MEDIUM_BOTH,
  CONTACT_MEDIUM_WATER,
  normalizeContactMediumMask,
  type ContactMediumMask,
} from '../network/contactMedium';
import { PRESENTED_ENTITY_POSITION_STRIDE } from '../network/ClientLockstepPresentation';
import { ENTITY_LOD_PROXY_GLYPH_CIRCLE } from './EntityLod3D';
import { LodProxyPointBatchRenderer3D } from './EntityLodProxyRenderer3D';
import { VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '../../visionConfig';

const STYLE = COLORS.effects.contactBlip;

export const CONTACT_BLIP_GLYPH = ENTITY_LOD_PROXY_GLYPH_CIRCLE;
export const CONTACT_BLIP_RADIUS = STYLE.radius;

type ContactBlipPresentation = Readonly<{
  kind: 'radar' | 'sonar' | 'dual';
  surface: 'terrain' | 'water';
  colorHex: number;
}>;

const RADAR_PRESENTATION: ContactBlipPresentation = Object.freeze({
  kind: 'radar',
  surface: 'terrain',
  colorHex: STYLE.radarColorHex,
});
const SONAR_PRESENTATION: ContactBlipPresentation = Object.freeze({
  kind: 'sonar',
  surface: 'water',
  colorHex: STYLE.sonarColorHex,
});
const DUAL_PRESENTATION: ContactBlipPresentation = Object.freeze({
  kind: 'dual',
  surface: 'water',
  colorHex: STYLE.dualColorHex,
});

/** Presentation is derived only from the earned contact lane. It deliberately
 * cannot inspect blueprint, owner, health, or body shape, because those are
 * identity facts a radar/sonar-only recipient has not earned. */
export function getContactBlipPresentation(
  mediumMask: ContactMediumMask | number | null | undefined,
): ContactBlipPresentation {
  switch (normalizeContactMediumMask(mediumMask)) {
    case CONTACT_MEDIUM_BOTH: return DUAL_PRESENTATION;
    case CONTACT_MEDIUM_WATER: return SONAR_PRESENTATION;
    default: return RADAR_PRESENTATION;
  }
}

/** Contact altitude is part of the sole current sensor contract. Invalid data
 * is a producer/transport defect and must not be projected onto a surface. */
export function requireContactBlipZ(
  contactZ: number | null | undefined,
): number {
  if (typeof contactZ === 'number' && Number.isFinite(contactZ)) return contactZ;
  throw new Error('[contact blip] radar/sonar contact is missing finite contactZ');
}

/** The contact id is the position-only key into the shared entity presentation
 * history. It never grants blueprint, owner, health, or other identity data. */
export function requireContactBlipId(
  contactId: number | null | undefined,
): number {
  if (typeof contactId === 'number' && Number.isFinite(contactId)) return contactId;
  throw new Error('[contact blip] radar/sonar contact is missing a contactId');
}

type ContactTrack = {
  sequence: number;
  /** Anonymous-contact visibility ramp: 0..1, rising over VISION_FADE_IN_MS
   *  while heard and falling over VISION_FADE_OUT_MS once the newest
   *  snapshot stops carrying the contact. A re-heard contact resumes rising
   *  from wherever the fall left it. */
  fadeAlpha: number;
  dying: boolean;
  /** Sensor lanes that earned this contact (CONTACT_MEDIUM_* bits), kept so
   *  the DISTANCE vision fade can read the matching friendly contact discs. */
  mediumMask: number;
  /** Current snapshot row for the non-lockstep compatibility fallback and for
   *  publishing the shared pose to the minimap. Never retained once unheard. */
  source: MinimapEntity | null;
};

/** Writes [valid, x, y, z] for each id. The batch is ephemeral and must use
 * the same presentation history/alpha as identified entity rendering. */
export type ContactBlipPositionResolver3D = (
  entityIds: readonly number[],
  out: Float32Array,
) => void;

/** Per-frame vision-fade presentation inputs for contacts. */
export type ContactBlipVisionFade3D = Readonly<{
  /** TIME fades active: blips rise/fall over the visionConfig durations and
   *  follow the shared entity pose while dying. Off in DISTANCE mode. */
  timeFades: boolean;
  /** DISTANCE presence for a contact at (x, y) earned via `mediumMask`
   *  (0..1); undefined = 1. */
  contactAlpha?: (x: number, y: number, mediumMask: number) => number;
}>;

/** Blips are anonymous knowledge, not bodies: pure black ring with a
 *  white core dot, one look for every lane. */
const CONTACT_BLIP_OUTLINE_COLOR = 0x000000;

const DEFAULT_CONTACT_BLIP_VISION_FADE: ContactBlipVisionFade3D = Object.freeze({ timeFades: true });

export class ContactBlipRenderer3D {
  private readonly proxyRenderer: LodProxyPointBatchRenderer3D;
  private readonly tracks = new Map<number, ContactTrack>();
  private readonly trackIds: number[] = [];
  private resolvedPositions = new Float32Array(0);
  private prunedSequence = -1;

  constructor(
    parent: THREE.Group,
    canvas?: HTMLCanvasElement,
  ) {
    this.proxyRenderer = new LodProxyPointBatchRenderer3D(parent, canvas);
  }

  update(
    contacts: readonly MinimapEntity[] | null,
    sequence: number,
    renderScope: ViewportFootprint | undefined,
    dtMs: number,
    visionFade: ContactBlipVisionFade3D = DEFAULT_CONTACT_BLIP_VISION_FADE,
    resolvePositions?: ContactBlipPositionResolver3D,
  ): void {
    this.proxyRenderer.beginFrame();
    const timeFades = visionFade.timeFades;
    const contactAlpha = visionFade.contactAlpha;

    // P1-26: the input array only carries new information when a snapshot
    // lands (its sequence moves). Only membership is consumed here; position
    // remains a per-render-frame read from the entity presentation history.
    if (contacts !== null && this.prunedSequence !== sequence) {
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        if (contact.radarOnly !== true) continue;
        const contactId = requireContactBlipId(contact.contactId);
        requireContactBlipZ(contact.contactZ);
        let track = this.tracks.get(contactId);
        if (track === undefined) {
          track = {
            sequence,
            fadeAlpha: 0,
            dying: false,
            mediumMask: 0,
            source: contact,
          };
          this.tracks.set(contactId, track);
        }
        track.sequence = sequence;
        track.dying = false;
        track.mediumMask = normalizeContactMediumMask(contact.contactMediumMask);
        track.source = contact;
      }
      this.dropUnheardContacts(sequence);
      this.prunedSequence = sequence;
    } else if (contacts === null) {
      // Coverage collapsed entirely: everything on screen fades away.
      for (const track of this.tracks.values()) {
        track.dying = true;
        track.source = null;
      }
    }

    const trackIds = this.trackIds;
    trackIds.length = 0;
    for (const [contactId, track] of this.tracks) {
      if (track.dying) {
        track.fadeAlpha = timeFades ? track.fadeAlpha - dtMs / VISION_FADE_OUT_MS : 0;
        if (track.fadeAlpha <= 0) {
          this.tracks.delete(contactId);
          continue;
        }
      } else {
        track.fadeAlpha = timeFades ? Math.min(1, track.fadeAlpha + dtMs / VISION_FADE_IN_MS) : 1;
      }
      trackIds.push(contactId);
    }

    const outputLength = trackIds.length * PRESENTED_ENTITY_POSITION_STRIDE;
    if (this.resolvedPositions.length < outputLength) {
      this.resolvedPositions = new Float32Array(outputLength);
    } else {
      this.resolvedPositions.fill(0, 0, outputLength);
    }
    resolvePositions?.(trackIds, this.resolvedPositions);

    for (let row = 0; row < trackIds.length; row++) {
      const track = this.tracks.get(trackIds[row]);
      if (track === undefined) continue;
      const positionBase = row * PRESENTED_ENTITY_POSITION_STRIDE;
      const hasSharedPose = this.resolvedPositions[positionBase] !== 0;
      const source = track.source;
      if (!hasSharedPose && source === null) continue;
      const x = hasSharedPose
        ? this.resolvedPositions[positionBase + 1]
        : source!.pos.x;
      const y = hasSharedPose
        ? this.resolvedPositions[positionBase + 2]
        : source!.pos.y;
      const z = hasSharedPose
        ? this.resolvedPositions[positionBase + 3]
        : requireContactBlipZ(source!.contactZ);

      // The minimap consumes the same contact rows after the world render
      // phase. Publish the shared pose into that row rather than leaving its
      // marker at the slower snapshot coordinate.
      if (hasSharedPose && source !== null) {
        source.pos.x = x;
        source.pos.y = y;
        source.contactZ = z;
      }
      if (renderScope !== undefined && !renderScope.inScope(x, y, STYLE.radius)) {
        continue;
      }
      // DISTANCE presence: how far inside the nearest friendly contact disc
      // the return sits (1 in TIME mode). Multiplies the TIME ramp.
      const presence = contactAlpha !== undefined
        ? contactAlpha(x, y, track.mediumMask)
        : 1;
      if (presence <= 0) continue;
      this.proxyRenderer.pushProxy(
        x,
        y,
        z + STYLE.surfaceLift,
        CONTACT_BLIP_RADIUS,
        CONTACT_BLIP_GLYPH,
        CONTACT_BLIP_OUTLINE_COLOR,
        STYLE.opacity * track.fadeAlpha * presence,
        CONTACT_BLIP_OUTLINE_COLOR,
      );
    }
    this.proxyRenderer.flush();
  }

  destroy(): void {
    this.dispose();
  }

  dispose(): void {
    this.tracks.clear();
    this.trackIds.length = 0;
    this.proxyRenderer.destroy();
  }

  /** Anything the newest snapshot did not carry has left contact
   *  coverage — it starts fading out from its current alpha instead of
   *  vanishing (the removal happens when the fade reaches zero). */
  private dropUnheardContacts(sequence: number): void {
    for (const track of this.tracks.values()) {
      if (track.sequence === sequence) continue;
      track.dying = true;
      track.source = null;
    }
  }
}
