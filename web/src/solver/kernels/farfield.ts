// Boundary pressure mixing from the v2412 freestreamPressure equations. The boundary velocity
// is reconstructed from the two adjoining cell values, including the velocity ghost condition.
// Shared source keeps the Poisson conductance and the velocity correction identical.
export const farfieldPressure = (velocity: string) => /* wgsl */ `
fn sidePressureFraction(q: i32, side: i32) -> f32 {
  let n = NC(); let upper = q+NX(); let xy = NX()*NY();
  let v = vec3<f32>(
    0.25*(${velocity}[u32(q)]+${velocity}[u32(q-1)]+${velocity}[u32(upper)]+${velocity}[u32(upper-1)]),
    ${velocity}[n+u32(q)],
    0.25*(${velocity}[2u*n+u32(q)]+${velocity}[2u*n+u32(q-xy)]+${velocity}[2u*n+u32(upper)]+${velocity}[2u*n+u32(upper-xy)]));
  return clamp(0.5+0.5*f32(side)*v.y/max(length(v),1e-9),0.0,1.0);
}
`;
