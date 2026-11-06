import * as T from 'three';
import { mapTexture } from '../viz/colormap';

/** Interpolate Cp numerically, then apply the main workspace's diverging palette and lighting. */
export function mapPressureMaterial(weights: T.Vector4, range: [number, number]) {
  const material = new T.MeshStandardMaterial({ roughness: .62, metalness: 0 });
  material.onBeforeCompile = shader => {
    shader.uniforms.uAeroWeights = { value: weights };
    shader.uniforms.uCpMap = { value: mapTexture('diverging') };
    shader.uniforms.uCpRange = { value: new T.Vector2(...range) };
    shader.vertexShader = 'attribute float aCp0; attribute float aCp1; attribute float aCp2; attribute float aCp3; uniform vec4 uAeroWeights; varying float vAeroCp;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvAeroCp=dot(vec4(aCp0,aCp1,aCp2,aCp3),uAeroWeights);');
    shader.fragmentShader = 'uniform sampler2D uCpMap; uniform vec2 uCpRange; varying float vAeroCp;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      float t = vAeroCp < 0. ? .5-.5*min(1.,vAeroCp/min(uCpRange.x,-1e-9)) : .5+.5*min(1.,vAeroCp/max(uCpRange.y,1e-9));
      diffuseColor.rgb *= texture2D(uCpMap,vec2(t,.5)).rgb;
    `);
  };
  material.customProgramCacheKey = () => 'track-cfd-numeric-cp-v1';
  return material;
}
