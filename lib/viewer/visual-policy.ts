/**
 * EyeSteel default IFC visuals — lighting and renderer caps.
 * IFC surface colours come from the file via That Open / fragments (do not bulk tint meshes).
 */

import * as THREE from "three";

/** Mobile/tablet: cap sharpness cost; desktop allows moderate retina upscale. */
export function getEyeSteelPixelRatioCap(): number {
  if (typeof window === "undefined") return 1.5;
  const tabletOrPhone =
    window.matchMedia("(max-width: 1024px)").matches ||
    window.matchMedia("(pointer: coarse)").matches;
  return tabletOrPhone ? 1.5 : 2;
}

export function applyEyeSteelRendererDefaults(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = false;
  const cap = getEyeSteelPixelRatioCap();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
}

/** Hemisphere + key directional + weak cool fill; all shadows off (cheap). */
export function createEyeSteelLights(scene: THREE.Object3D): THREE.Light[] {
  const hemi = new THREE.HemisphereLight(0xf2f5fb, 0x343d4d, 0.58);
  hemi.name = "eyeSteel-hemi";

  const key = new THREE.DirectionalLight(0xfff8f3, 0.92);
  key.position.set(52, 84, 38);
  key.castShadow = false;
  key.name = "eyeSteel-key";

  const fill = new THREE.DirectionalLight(0xe4ecf8, 0.2);
  fill.position.set(-36, 28, -44);
  fill.castShadow = false;
  fill.name = "eyeSteel-fill";

  scene.add(hemi, key, fill);
  return [hemi, key, fill];
}

/** Default viewer backdrop (also restored when exiting sketch mode). */
export const EYE_STEEL_SCENE_BACKGROUND_HEX = 0xe8ecef;

/** Very slight cool backdrop so profiles separate from void without fog/AO. */
export function applyEyeSteelSceneBackdrop(sceneRoot: THREE.Object3D): void {
  const scene = sceneRoot as THREE.Scene;
  scene.background = new THREE.Color(EYE_STEEL_SCENE_BACKGROUND_HEX);
}

/** Warm industrial accent for fragment GPU highlight (That Open only draws selection). */
export const SELECTION_HIGHLIGHT_COLOR = new THREE.Color(0xedae3b);
