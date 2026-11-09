#pragma once
// The upstream core uses only row-major, non-transposed DGEMV.
enum CBLAS_ORDER { CblasRowMajor=101, CblasColMajor=102 };
enum CBLAS_TRANSPOSE { CblasNoTrans=111, CblasTrans=112, CblasConjTrans=113 };
#ifdef __cplusplus
extern "C" {
#endif
void cblas_dgemv(enum CBLAS_ORDER,enum CBLAS_TRANSPOSE,int,int,double,const double*,int,const double*,int,double,double*,int);
#ifdef __cplusplus
}
#endif
