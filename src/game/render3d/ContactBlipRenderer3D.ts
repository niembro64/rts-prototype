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
// Contacts are the one moving visual that cannot ride the client prediction
// stepper -- there is no blueprint, velocity, or order set to predict from -- so
// they arrive only on presentation snapshots, far slower than the render loop.
// The blip is therefore interpolated between its last two received positions,
// the same clamped glide the fixed-tick presentation history gives everything
// else, and is never extrapolated past the newest sample.
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
import type { ContactSnapshotSampling } from '../network/ClientMinimapOverrideStore';
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

/** The contact id is the interpolation key, and nothing else: without it a
 * sample cannot be matched to the one before it and the blip would restart from
 * a standstill on every snapshot. Like the altitude, a missing id is a
 * producer/transport defect rather than something to paper over. */
export function requireContactBlipId(
  contactId: number | null | undefined,
): number {
  if (typeof contactId === 'number' && Number.isFinite(contactId)) return contactId;
  throw new Error('[contact blip] radar/sonar contact is missing a contactId');
}

/** One contact's glide: where it was last drawn, where the newest sample puts
 *  it, and the sample that pair belongs to. */
type ContactTrack = {
  sequence: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  x: number;
  y: number;
  z: number;
  /** Same ramp enemy entities use entering/leaving vision: 0..1, rising
   *  over VISION_FADE_IN_MS while heard, falling over VISION_FADE_OUT_MS
   *  once the newest snapshot stops carrying the contact. A re-heard
   *  contact resumes rising from wherever the fall left it. */
  fadeAlpha: number;
  dying: boolean;
};

/** Blips are anonymous knowledge, not bodies: pure black ring with a
 *  white core dot, one look for every lane. */
const CONTACT_BLIP_OUTLINE_COLOR = 0x000000;

export class ContactBlipRenderer3D {
  private readonly proxyRenderer: LodProxyPointBatchRenderer3D;
  private readonly tracks = new Map<number, ContactTrack>();
  private prunedSequence = -1;

  constructor(
    parent: THREE.Group,
    canvas?: HTMLCanvasElement,
  ) {
    this.proxyRenderer = new LodProxyPointBatchRenderer3D(parent, canvas);
  }

  update(
    contacts: readonly MinimapEntity[] | null,
    sampling: ContactSnapshotSampling,
    renderScope: ViewportFootprint | undefined,
    dtMs: number,
  ): void {
    this.proxyRenderer.beginFrame();
    const sequence = sampling.sequence;
    const alpha = sampling.alpha;

    if (contacts !== null) {
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        if (contact.radarOnly !== true) continue;
        // Tracked before the scope test so a contact that leaves and re-enters the
        // view resumes its glide instead of popping to the newest sample.
        const track = this.advance(
          requireContactBlipId(contact.contactId),
          contact.pos.x,
          contact.pos.y,
          requireContactBlipZ(contact.contactZ),
          sequence,
          alpha,
        );
        track.dying = false;
        track.fadeAlpha = Math.min(1, track.fadeAlpha + dtMs / VISION_FADE_IN_MS);
      }
      if (this.prunedSequence !== sequence) {
        this.dropUnheardContacts(sequence);
        this.prunedSequence = sequence;
      }
    } else {
      // Coverage collapsed entirely: everything on screen fades away.
      for (const track of this.tracks.values()) track.dying = true;
    }

    for (const [contactId, track] of this.tracks) {
      if (track.dying) {
        track.fadeAlpha -= dtMs / VISION_FADE_OUT_MS;
        if (track.fadeAlpha <= 0) {
          this.tracks.delete(contactId);
          continue;
        }
      }
      if (renderScope !== undefined && !renderScope.inScope(track.x, track.y, STYLE.radius)) {
        continue;
      }
      this.proxyRenderer.pushProxy(
        track.x,
        track.y,
        track.z + STYLE.surfaceLift,
        CONTACT_BLIP_RADIUS,
        CONTACT_BLIP_GLYPH,
        CONTACT_BLIP_OUTLINE_COLOR,
        STYLE.opacity * track.fadeAlpha,
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
    this.proxyRenderer.destroy();
  }

  /** A newly heard contact appears at rest on its reported position -- there is
   *  no earlier sample to glide from. An already-tracked one glides from where
   *  it was last drawn, so a sample arriving early or late never pops. */
  private advance(
    contactId: number,
    x: number,
    y: number,
    z: number,
    sequence: number,
    alpha: number,
  ): ContactTrack {
    let track = this.tracks.get(contactId);
    if (track === undefined) {
      track = {
        sequence,
        fromX: x, fromY: y, fromZ: z,
        toX: x, toY: y, toZ: z,
        x, y, z,
        fadeAlpha: 0,
        dying: false,
      };
      this.tracks.set(contactId, track);
      return track;
    }
    if (track.sequence !== sequence) {
      track.sequence = sequence;
      track.fromX = track.x;
      track.fromY = track.y;
      track.fromZ = track.z;
      track.toX = x;
      track.toY = y;
      track.toZ = z;
    }
    track.x = track.fromX + (track.toX - track.fromX) * alpha;
    track.y = track.fromY + (track.toY - track.fromY) * alpha;
    track.z = track.fromZ + (track.toZ - track.fromZ) * alpha;
    return track;
  }

  /** Anything the newest snapshot did not carry has left contact
   *  coverage — it starts fading out from its current alpha instead of
   *  vanishing (the removal happens when the fade reaches zero). */
  private dropUnheardContacts(sequence: number): void {
    for (const track of this.tracks.values()) {
      if (track.sequence !== sequence) track.dying = true;
    }
  }
}
