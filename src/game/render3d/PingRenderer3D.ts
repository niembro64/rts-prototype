import * as THREE from 'three';

type Ping = {
  mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  ageMs: number;
  lifetimeMs: number;
};

const MAX_PINGS = 24;
const PING_LIFETIME_MS = 1500;
const START_RADIUS = 10;
const END_RADIUS = 120;
const PING_Y_OFFSET = 2;

function createPingMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export class PingRenderer3D {
  private readonly root: THREE.Group;
  private readonly geometry: THREE.TorusGeometry;
  private readonly pings: Ping[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    this.root.renderOrder = 1000;
    parentWorld.add(this.root);

    this.geometry = new THREE.TorusGeometry(1, 0.035, 8, 96);
    this.geometry.rotateX(Math.PI / 2);
  }

  spawn(simX: number, simY: number, simZ: number, color: number): void {
    if (this.pings.length >= MAX_PINGS) {
      const oldest = this.pings.shift();
      if (oldest) this.releasePing(oldest);
    }

    const mesh = new THREE.Mesh(this.geometry, createPingMaterial(color));
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    mesh.position.set(simX, simZ + PING_Y_OFFSET, simY);
    mesh.scale.setScalar(START_RADIUS);
    this.root.add(mesh);
    this.pings.push({
      mesh,
      ageMs: 0,
      lifetimeMs: PING_LIFETIME_MS,
    });
  }

  update(dtMs: number): void {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i];
      ping.ageMs += dtMs;
      const t = Math.min(1, ping.ageMs / ping.lifetimeMs);
      const eased = 1 - Math.pow(1 - t, 2);
      const radius = START_RADIUS + (END_RADIUS - START_RADIUS) * eased;
      ping.mesh.scale.setScalar(radius);
      ping.mesh.material.opacity = Math.max(0, 1 - t);
      ping.mesh.position.y += dtMs * 0.012;

      if (t >= 1) {
        this.pings.splice(i, 1);
        this.releasePing(ping);
      }
    }
  }

  destroy(): void {
    for (let i = 0; i < this.pings.length; i++) {
      this.releasePing(this.pings[i]);
    }
    this.pings.length = 0;
    this.geometry.dispose();
    this.root.removeFromParent();
  }

  private releasePing(ping: Ping): void {
    ping.mesh.removeFromParent();
    ping.mesh.material.dispose();
  }
}
