// The sky dome: three's SkyMesh (Preetham daylight with fbm clouds; Copyright © 2010-2026 three.js
// authors, MIT License, LICENSES/MIT-three.js.txt),
// with three changes for the island. Its clouds drift with the scene's wind (by an offset the
// wind advances, rather than along a fixed diagonal at a fixed speed), so they sail the same way
// as their shadows and faster in a storm; lightning lights them from within; and at night a moon
// hangs where the moonlight comes from, behind the clouds like the sun.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, float, floor, fract, vec2, vec3, acos, add, mul, clamp, cos, dot, exp, max, min, mix, modelViewProjection, normalize, positionWorld, pow, smoothstep, sub, varyingProperty, vec4, uniform, cameraPosition, If, Loop } from 'three/tsl';
import { cloudEvolve, cloudTravel } from './wind';

// three's cloud noise: a sinless hash gradient noise and four octaves that drift apart.
const gradient = Fn(([i]: [Node<'vec2'>]) => {
  const p = fract(i.xyx.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p.addAssign(dot(p, p.yzx.add(33.33)));
  return fract(p.xx.add(p.yz).mul(p.zy)).mul(2.0).sub(1.0);
});
const noise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0));
  const a = dot(gradient(i), f);
  const b = dot(gradient(i.add(vec2(1.0, 0.0))), f.sub(vec2(1.0, 0.0)));
  const c2 = dot(gradient(i.add(vec2(0.0, 1.0))), f.sub(vec2(0.0, 1.0)));
  const d = dot(gradient(i.add(vec2(1.0, 1.0))), f.sub(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c2, d, u.x), u.y).mul(1.6);
});
const fbm = Fn(([position, drift]: [Node<'vec2'>, Node<'float'>]) => {
  const p = vec2(position).toVar();
  const result = float(0.0).toVar();
  const amplitude = float(1.0).toVar();
  Loop(4, () => {
    result.addAssign(amplitude.mul(noise(p)));
    amplitude.mulAssign(0.5);
    p.mulAssign(2.0);
    p.addAssign(drift);
  });
  return result;
});

export class IslandSky extends THREE.Mesh {
  turbidity = uniform(2);
  rayleigh = uniform(1);
  mieCoefficient = uniform(0.005);
  mieDirectionalG = uniform(0.8);
  sunPosition = uniform(new THREE.Vector3());
  cloudScale = uniform(0.0002);
  cloudCoverage = uniform(0.4);
  cloudDensity = uniform(0.4);
  cloudElevation = uniform(0.5);
  showSunDisc = uniform(1);
  /** Towards the moon (normalised), and how much of it shows (0 by day). */
  moonDirection = uniform(new THREE.Vector3(0, 1, 0));
  moonLight = uniform(0);
  /** A lightning flash lighting the clouds (0..~1.2), brightest towards `flashDirection`. */
  flash = uniform(0);
  flashDirection = uniform(new THREE.Vector3(0, 1, 0));
  readonly isSkyMesh = true;

  /**
   * The cloud layer in a view direction (above the horizon): its noise, the coverage threshold,
   * mask and thickness, and how opaque it is there. The stars ask it too, to go behind clouds.
   */
  clouds(direction: Node<'vec3'>) {
    const elevation = mix(1.0, 0.1, this.cloudElevation);
    const cloudUV = direction.xz.div(direction.y.max(1e-4).mul(elevation)).toVar();
    cloudUV.mulAssign(this.cloudScale);
    // (Wind-driven: see wind.ts. The pattern is sampled at uv + offset, so it moves against it.)
    cloudUV.addAssign(cloudTravel);
    const cloudNoise = fbm(cloudUV.mul(1000.0), cloudEvolve).mul(0.7).add(0.5).clamp(0.0, 1.0).toVar();
    const region = noise(cloudUV.mul(300.0)).mul(0.37).add(0.5);
    const cov = clamp(this.cloudCoverage.add(region.sub(0.5).mul(0.6)), 0.0, 1.0);
    const threshold = sub(1.0, cov).toVar();
    const cloudMask = smoothstep(threshold, threshold.add(0.3), cloudNoise).toVar();
    const horizonFade = smoothstep(0.0, add(0.03, mul(0.06, this.cloudElevation)), direction.y);
    cloudMask.mulAssign(horizonFade);
    const depth = max(0.0, cloudNoise.sub(threshold)).toVar();
    const alpha = sub(1.0, exp(depth.mul(this.cloudDensity).mul(-12.0))).mul(horizonFade).toVar();
    return { cloudNoise, threshold, cloudMask, horizonFade, depth, alpha };
  }

  constructor() {
    const material = new THREE.NodeMaterial();
    super(new THREE.BoxGeometry(1, 1, 1), material);

    const vSunDirection = varyingProperty('vec3');
    const vSunE = varyingProperty('float');
    const vBetaR = varyingProperty('vec3');
    const vBetaM = varyingProperty('vec3');

    const vertexNode = Fn(() => {
      const e = float(2.718281828459045);
      const totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
      const MieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
      const cutoffAngle = float(1.6110731556870734);
      const steepness = float(1.5);
      const EE = float(1000.0);
      const sunDirection = normalize(this.sunPosition);
      vSunDirection.assign(sunDirection);
      const angle = sunDirection.y;
      const zenithAngleCos = clamp(angle, -1, 1);
      const sunIntensity = EE.mul(max(0.0, float(1.0).sub(pow(e, cutoffAngle.sub(acos(zenithAngleCos)).div(steepness).negate()))));
      vSunE.assign(sunIntensity);
      const sunfade = float(1.0).sub(clamp(float(1.0).sub(exp(this.sunPosition.y.div(450000.0))), 0, 1));
      const rayleighCoefficient = this.rayleigh.sub(float(1.0).mul(float(1.0).sub(sunfade)));
      vBetaR.assign(totalRayleigh.mul(rayleighCoefficient));
      const c = float(0.2).mul(this.turbidity).mul(10e-18);
      const totalMie = float(0.434).mul(c).mul(MieConst);
      vBetaM.assign(totalMie.mul(this.mieCoefficient));
      const position = modelViewProjection as unknown as Node<'vec4'>;
      position.z.assign(position.w);
      return position;
    })();

    const colorNode = Fn(() => {
      const pi = float(3.141592653589793);
      const rayleighZenithLength = float(8.4e3);
      const mieZenithLength = float(1.25e3);
      const sunAngularDiameterCos = float(0.9999566769464484);
      const THREE_OVER_SIXTEENPI = float(0.05968310365946075);
      const ONE_OVER_FOURPI = float(0.07957747154594767);
      const direction = normalize(positionWorld.sub(cameraPosition));
      const zenithAngle = acos(max(0.0, direction.y));
      const inverse = float(1.0).div(cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(pi)), -1.253))));
      const sR = rayleighZenithLength.mul(inverse);
      const sM = mieZenithLength.mul(inverse);
      const Fex = exp(mul(vBetaR, sR).add(mul(vBetaM, sM)).negate());
      const cosTheta = dot(direction, vSunDirection);
      const c = cosTheta.mul(0.5).add(0.5);
      const rPhase = THREE_OVER_SIXTEENPI.mul(float(1.0).add(pow(c, 2.0)));
      const betaRTheta = vBetaR.mul(rPhase);
      const g2 = pow(this.mieDirectionalG, 2.0);
      const inv = float(1.0).div(pow(float(1.0).sub(float(2.0).mul(this.mieDirectionalG).mul(cosTheta)).add(g2), 1.5));
      const mPhase = ONE_OVER_FOURPI.mul(float(1.0).sub(g2)).mul(inv);
      const betaMTheta = vBetaM.mul(mPhase);
      const Lin = pow(vSunE.mul(add(betaRTheta, betaMTheta).div(add(vBetaR, vBetaM))).mul(sub(1.0, Fex)), vec3(1.5));
      Lin.mulAssign(mix(vec3(1.0), pow(vSunE.mul(add(betaRTheta, betaMTheta).div(add(vBetaR, vBetaM))).mul(Fex), vec3(1.0 / 2.0)), clamp(pow(sub(1.0, vSunDirection.y), 5.0), 0.0, 1.0)));
      const L0 = vec3(0.1).mul(Fex);
      const sundisc = clamp(cosTheta.sub(sunAngularDiameterCos).mul(50000.0), 0.0, 1.0).mul(this.showSunDisc);
      const sundiscColor = min(vSunE.mul(Fex), 80.0).mul(760.0).mul(sundisc);

      // The moon: a pale disc (about 2.4° across, larger than life so it reads at the game's
      // scale) with a darker limb and faint maria, in a soft halo of moonlit haze.
      const cosMoon = dot(direction, this.moonDirection);
      const moonR = 0.021;
      const fromCentre = acos(clamp(cosMoon, -1, 1)).div(moonR);
      const disc = smoothstep(1.0, 0.94, fromCentre);
      const limb = mix(float(0.72), float(1), smoothstep(1.0, 0.2, fromCentre));
      // Seas from the direction's offset off the moon's centre (a fixed pattern on its face).
      const off = direction.sub(this.moonDirection).div(moonR);
      const maria = smoothstep(0.35, 0.0, vec2(off.x.add(0.25), off.z.sub(0.2)).length()).mul(0.18).add(smoothstep(0.3, 0.0, vec2(off.x.sub(0.3), off.y.add(0.25)).length()).mul(0.14));
      const halo = pow(max(cosMoon, 0), 900).mul(0.06).add(pow(max(cosMoon, 0), 60).mul(0.012));
      const moonColor = vec3(1.0, 0.97, 0.9).mul(disc.mul(limb).mul(float(1).sub(maria)).mul(1.25)).add(vec3(0.55, 0.62, 0.85).mul(halo)).mul(this.moonLight);

      const texColor = add(Lin, L0).mul(0.04).add(sundiscColor).add(moonColor).add(vec3(0.0, 0.0003, 0.00075)).toVar();

      If(direction.y.greaterThan(0.0).and(this.cloudCoverage.greaterThan(0.0)), () => {
        const { cloudMask, depth, alpha } = this.clouds(direction);
        const dayFactor = smoothstep(-0.08, 0.3, vSunDirection.y);
        const sunColor = vSunE.mul(Fex).mul(0.22).mul(0.04).toVar();
        const skyAmbient = Lin.mul(0.04).add(vec3(0.0, 0.0003, 0.00075));
        const beer = exp(depth.mul(-4.0)).toVar();
        const powder = sub(1.0, beer.mul(beer));
        const shade = mix(0.45, 1.0, beer.mul(powder).mul(2.6).clamp(0.0, 1.0));
        const silver = float(0.51).div(pow(sub(1.49, cosTheta.mul(1.4)), 1.5)).clamp(0.0, 3.0);
        const edge = cloudMask.mul(sub(1.0, cloudMask)).mul(4.0);
        const cloudColor = skyAmbient.add(sunColor.mul(shade)).toVar();
        cloudColor.addAssign(sunColor.mul(silver).mul(edge).mul(0.6));
        cloudColor.mulAssign(dayFactor.max(0.03));
        texColor.subAssign(L0.mul(0.04).add(sundiscColor).add(moonColor).mul(alpha));
        const cloudAerial = mix(texColor, cloudColor, Fex);
        texColor.assign(mix(texColor, cloudAerial, alpha));
        // Light of their own, added past the haze (whose reddening would turn it brown low down),
        // fading towards the horizon. Moonlit at night: a faint cool light, silvered round the moon.
        // Lightning lights them from inside: thin cloud glows through, thick cloud less so.
        const low = smoothstep(0.02, 0.2, direction.y);
        const moonSilver = pow(max(cosMoon, 0), 12).mul(edge.add(0.3));
        const moonlit = vec3(0.02, 0.025, 0.04).mul(shade.add(moonSilver.mul(2))).mul(this.moonLight);
        const toFlash = max(dot(direction, this.flashDirection), 0);
        const flashLit = vec3(0.62, 0.68, 0.95).mul(pow(toFlash, 6).mul(0.8).add(0.2).mul(this.flash)).mul(beer.mul(0.6).add(0.4));
        texColor.addAssign(moonlit.add(flashLit).mul(alpha).mul(low));
      });

      return vec4(texColor, 1.0);
    })();

    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.fog = false;
    material.vertexNode = vertexNode;
    material.colorNode = colorNode;
  }
}
