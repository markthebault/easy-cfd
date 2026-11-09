#include "cblas.h"
#include <stdio.h>
#include <stdlib.h>
void cblas_dgemv(enum CBLAS_ORDER order,enum CBLAS_TRANSPOSE trans,int m,int n,double alpha,const double*a,int lda,const double*x,int incx,double beta,double*y,int incy) {
  if(order!=CblasRowMajor || trans!=CblasNoTrans) abort();
  for(int i=0;i<m;i++){double sum=0;for(int j=0;j<n;j++)sum+=a[i*lda+j]*x[j*incx];y[i*incy]=alpha*sum+(beta==0?0:beta*y[i*incy]);}
}
int xerbla_(char *name, long *info) { fprintf(stderr,"LAPACK error %.6s %ld\n",name,*info);abort(); }
// CLAPACK 3.2.1 declares these f2c string helpers with an int return.
// Supply matching signatures instead of libf2c's void-return definitions.
#include <string.h>
int s_copy(char*a,char*b,long la,long lb){long n=la<lb?la:lb;memmove(a,b,n);if(la>n)memset(a+n,' ',la-n);return 0;}
int s_cat(char*dst,char**src,long*lens,long*count,long length){
 char*tmp=malloc(length);if(!tmp)abort();long pos=0;
 for(long i=0;i<*count&&pos<length;i++){long n=lens[i]<length-pos?lens[i]:length-pos;memcpy(tmp+pos,src[i],n);pos+=n;}
 if(pos<length)memset(tmp+pos,' ',length-pos);memcpy(dst,tmp,length);free(tmp);return 0;
}
#include <float.h>
// DGETF2 asks only for the IEEE-754 safe minimum. WASM f64 is binary64.
double dlamch_(char*what){if(*what=='S'||*what=='s')return DBL_MIN;fprintf(stderr,"Unsupported DLAMCH query\n");abort();}
