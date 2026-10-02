import {test} from "node:test";
import assert from "node:assert/strict";
import {comparison,coefficientError,LIMIT} from "../validation/accuracy-metrics.mjs";

const result = {cd:.3,cl:-.2,settled:true,cdBand:.001,clBand:.001,diagnostics:{nonFinite:0,clipped:0,relativeDivergence:.00001}};
const reference = {cd:.3,cl:-.2,settingsMatch:true,forceSettled:true,residualConverged:true,meshIndependent:true};
test("3 percent requires both drag and signed lift agreement",()=>{
  assert.equal(comparison(result,reference).qualified,true);
  assert.equal(comparison({...result,cl:.2},reference).agrees,false);
  assert.equal(comparison({...result,cd:.31},reference).agrees,false);
  assert.equal(coefficientError(NaN,.3),Infinity);
  assert.equal(LIMIT,100);
});
test("matching numbers do not qualify an unresolved reference or unstable solution",()=>{
  for(const flag of ["forceSettled","residualConverged","meshIndependent"]) assert.equal(comparison(result,{...reference,[flag]:false}).qualified,false);
  assert.equal(comparison(result,{...reference,settingsMatch:false}).agrees,false);
  assert.equal(comparison({...result,clBand:.02},reference).qualified,false);
  assert.equal(comparison({...result,diagnostics:{nonFinite:1,clipped:0}},reference).qualified,false);
  assert.equal(comparison({...result,diagnostics:{nonFinite:0,clipped:0,relativeDivergence:.02}},reference).qualified,false);
  assert.equal(comparison(result,null).qualified,false);
});
test("a separate 5 percent campaign keeps the signed lift requirement and strict bound",()=>{
  assert.equal(comparison({...result,cd:.313,cl:-.208},reference,.05).agrees,true);
  assert.equal(comparison({...result,cd:.316},reference,.05).agrees,false);
  assert.equal(comparison({...result,cl:.2},reference,.05).agrees,false);
  assert.equal(comparison({...result,cd:.313},reference).agrees,false);
  assert.throws(()=>comparison(result,reference,0),/Tolerance/);
});
