// Browser adapter for vvflow f6419b3a. Numerical step order follows simulate().
#include "TSpace.hpp"
#include "TSortedTree.hpp"
#include "MConvectiveFast.hpp"
#include "MEpsilonFast.hpp"
#include "MDiffusiveFast.hpp"
#include "MFlowmove.hpp"
#include <algorithm>
#include <memory>
#include <stdexcept>
#include <vector>
#include <string>
#include <cstdio>
#include <cstdlib>

namespace {
#include "mx5-outline.inc"
std::unique_ptr<Space> space;
std::unique_ptr<TSortedTree> tree;
std::unique_ptr<MConvectiveFast> convective;
std::unique_ptr<MEpsilonFast> epsilon;
std::unique_ptr<MDiffusiveFast> diffusive;
std::unique_ptr<MFlowmove> flowmove;
const void* collision=nullptr;
std::vector<double> particles, bodies;
double stats[10]={};
std::string error;
void dispose(){
  if(tree) tree->destroy();
  flowmove.reset();diffusive.reset();epsilon.reset();convective.reset();tree.reset();space.reset();
  particles.clear();bodies.clear();collision=nullptr;
  std::fill(stats,stats+10,0.0);
}
std::vector<TVec> resample(const std::vector<TVec>& src,int n){
  std::vector<double> length{0};
  for(size_t i=0;i<src.size();i++)length.push_back(length.back()+(src[(i+1)%src.size()]-src[i]).abs());
  std::vector<TVec> result;size_t j=0;
  for(int i=0;i<n;i++){double target=length.back()*i/n;while(j+1<src.size()&&length[j+1]<target)j++;
    double f=(target-length[j])/(length[j+1]-length[j]);result.push_back(src[j]*(1-f)+src[(j+1)%src.size()]*f);}
  return result;
}
void addBody(const std::vector<TVec>& points, TVec axis={}){
  auto b=std::make_shared<TBody>();
  for(auto p:points)b->alist.emplace_back(p,false);
  b->holder.r=axis;b->doUpdateSegments();b->doFillProperties();b->validate(true);
  space->BodyList.push_back(b);
}
void snapshot(){
  particles.clear();bodies.clear();
  for(const auto&p:space->VortexList){
    if(!std::isfinite(p.r.x)||!std::isfinite(p.r.y)||!std::isfinite(p.g))throw std::runtime_error("Non-finite vortex state; reduce timestep or resolution.");
    particles.insert(particles.end(),{p.r.x,p.r.y,p.g,p._1_eps>0?1/p._1_eps:0});
  }
  int i=0;
  for(const auto&b:space->BodyList){for(const auto&a:b->alist)bodies.insert(bodies.end(),{a.corner.x,a.corner.y,double(i)});i++;}
  stats[0]=double(space->time);stats[4]=space->VortexList.size();stats[5]=space->step_number();
  stats[6]=space->BodyList.size()>1?(space->BodyList[1]->holder.o+space->BodyList[1]->dpos.o):0;
  stats[7]=space->gsum();stats[8]=space->integral();
}
}
extern "C" {
void vv_dispose(){dispose();}
const char* vv_error(){return error.c_str();}
int vv_init(int shape,int panels,double reynolds,double dt,double angle){
  try{
    dispose();error.clear();
    if(shape<0||shape>3||panels<40||panels>400||reynolds<20||reynolds>100000||dt<.001||dt>.05||!std::isfinite(reynolds)||!std::isfinite(dt)||!std::isfinite(angle)||std::abs(angle)>30)throw std::runtime_error("Invalid case parameters");
    space=std::make_unique<Space>();space->re=reynolds;space->pr=1;space->inf_vx="1";space->dt=TTime::makeWithSecondsDecimal(dt);
    if(shape==0){std::vector<TVec> p;for(int i=0;i<panels;i++){double a=2*M_PI*(1-double(i)/panels);p.emplace_back(.5*cos(a),.5*sin(a));}addBody(p);}
    else if(shape==3){
      addBody(resample(mx5_outline,panels));
    }
    else{
      std::vector<TVec> p;
      // Clockwise closed NACA-0012 contour, uniformly resampled in arclength.
      for(int i=0;i<1000;i++){double theta=2*M_PI*i/1000,x=(1-cos(theta))/2;
        double y=.6*(.2969*sqrt(x)-.126*x-.3516*x*x+.2843*x*x*x-.1036*x*x*x*x);
        p.emplace_back(x,i<=500?y:-y);}
      double a=-angle*M_PI/180;auto rotate=[a](TVec p){p.x-=.25;return TVec(.25+p.x*cos(a)-p.y*sin(a),p.x*sin(a)+p.y*cos(a));};
      p=resample(p,panels);for(auto&v:p)v=rotate(v);addBody(p,TVec(.25,0));
      if(shape==2){TVec pivot=rotate(TVec(.68,.052));
        std::vector<TVec> plate{{0,0},{0,.006},{.12,.006},{.12,0}};
        plate=resample(plate,std::max(20,panels/8));for(auto&v:plate){double x=v.x;v=TVec(x*cos(a)-v.y*sin(a),x*sin(a)+v.y*cos(a))+pivot;}
        addBody(plate,pivot);auto&flap=*space->BodyList.back();
        // Smooth 60-degree deployment at t=5..7, retraction at t=15..17.
        flap.speed_o="((t>=5 and t<7) and (pi*pi/12*sin(pi*(t-5)/2))) or ((t>=15 and t<17) and (-pi*pi/12*sin(pi*(t-15)/2))) or 0";
      }
    }
    space->EnumerateBodies();double dl=space->average_segment_length();
    tree=std::make_unique<TSortedTree>(space.get(),8,5*dl,100*dl);
    convective=std::make_unique<MConvectiveFast>(space.get(),tree.get());
    epsilon=std::make_unique<MEpsilonFast>(space.get(),tree.get());
    diffusive=std::make_unique<MDiffusiveFast>(space.get(),tree.get());
    flowmove=std::make_unique<MFlowmove>(space.get());snapshot();return 0;
  }catch(const std::exception&e){error=e.what();dispose();return -1;}
}
int vv_step(int count){
  try{
    if(!space||count<1||count>32)throw std::runtime_error("Invalid advance request");
    for(int k=0;k<count;k++){
      if(space->VortexList.size()>100000)throw std::runtime_error("100,000-vortex preview limit reached. Reset or choose a coarser surface.");
      tree->build();if(collision)convective->calc_circulation(&collision);convective->calc_circulation(&collision);tree->destroy();
      flowmove->heat_shed();flowmove->vortex_shed();flowmove->streak_shed();space->calc_forces();
      TVec3D force;for(const auto&b:space->BodyList){force=force+b->force_hydro;force.o+=rotl(b->get_axis())*b->force_hydro.r;}
      stats[1]=2*force.r.x;stats[2]=2*force.r.y;stats[3]=2*force.o;stats[9]=double(space->time);
      if(!std::isfinite(stats[1])||!std::isfinite(stats[2])||!std::isfinite(stats[3]))throw std::runtime_error("Non-finite force; reset with a smaller timestep.");
      space->zero_forces();tree->build();epsilon->CalcEpsilonFast(true);convective->process_all_lists();
      diffusive->process_vort_list();diffusive->process_heat_list();tree->destroy();
      flowmove->move_and_clean(true,&collision);flowmove->heat_crop();space->finish_step();
    }
    snapshot();return 0;
  }catch(const std::exception&e){error=e.what();if(tree)tree->destroy();return -1;}
}
int vv_count(){return particles.size()/4;}
const double* vv_particles(){return particles.data();}
int vv_body_count(){return bodies.size()/3;}
const double* vv_bodies(){return bodies.data();}
const double* vv_stats(){return stats;}
}
#ifndef __EMSCRIPTEN__
int main(int argc,char**argv){
 int shape=argc>1?atoi(argv[1]):0,panels=argc>2?atoi(argv[2]):80,steps=argc>3?atoi(argv[3]):100;
 double re=argc>4?atof(argv[4]):100,dt=argc>5?atof(argv[5]):.02,angle=argc>6?atof(argv[6]):0;
 if(vv_init(shape,panels,re,dt,angle)){fprintf(stderr,"%s\n",vv_error());return 1;}
 for(int i=0;i<steps;i++){if(vv_step(1)){fprintf(stderr,"%s\n",vv_error());return 1;}}
 printf("{\"stats\":[");for(int i=0;i<10;i++)printf("%s%.17g",i?",":"",stats[i]);printf("],\"particles\":[");
 for(size_t i=0;i<particles.size();i++)printf("%s%.17g",i?",":"",particles[i]);printf("]}\n");dispose();
}
#endif
