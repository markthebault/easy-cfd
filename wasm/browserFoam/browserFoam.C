// GPL-3.0-or-later. OpenFOAM's stock simpleFoam equations on a static mesh.
// The UI adapter only adds force integration and sampling; no substitute solver.
#include "fvCFD.H"
#include "singlePhaseTransportModel.H"
#include "turbulentTransportModel.H"
#include "simpleControl.H"
#include "fvOptions.H"
#include "meshSearch.H"
#include "interpolationCellPoint.H"
#include <fstream>
#include <iomanip>
#include <vector>

using namespace Foam;

static void writeFloat(std::ofstream& out, scalar value)
{
    const float v = float(value);
    out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

static void writeVector(std::ofstream& out, const vector& v)
{
    for (direction c=0; c<3; ++c) writeFloat(out, v[c]);
}

static void sampleVolume
(
    const fvMesh& mesh, const volVectorField& U, const volScalarField& p,
    const volScalarField& k, const dictionary& cfg, const fileName& file
)
{
    const vector origin(cfg.get<vector>("vizOrigin"));
    const vector spacing(cfg.get<vector>("vizSpacing"));
    const vector dims(cfg.get<vector>("vizDims"));
    const label nx=label(dims.x()), ny=label(dims.y()), nz=label(dims.z());
    const label n=nx*ny*nz;
    std::vector<float> data(5*n, 0);
    std::vector<unsigned char> valid(n, 0);
    meshSearch search(mesh);
    interpolationCellPoint<vector> interpU(U);
    interpolationCellPoint<scalar> interpP(p), interpK(k);
    label at=0;
    for (label z=0; z<nz; ++z)
    for (label y=0; y<ny; ++y)
    for (label x=0; x<nx; ++x, ++at)
    {
        const point q=origin+vector(x*spacing.x(), y*spacing.y(), z*spacing.z());
        const label cell=search.findCell(q, -1, true);
        if (cell<0) continue;
        const vector v=interpU.interpolate(q, cell);
        data[at]=v.x(); data[n+at]=v.y(); data[2*n+at]=v.z();
        data[3*n+at]=interpP.interpolate(q, cell);
        data[4*n+at]=interpK.interpolate(q, cell);
        valid[at]=1;
    }
    std::ofstream out(file.c_str(), std::ios::binary);
    out.write(reinterpret_cast<const char*>(data.data()), data.size()*sizeof(float));
    out.write(reinterpret_cast<const char*>(valid.data()), valid.size());
}

int main(int argc, char* argv[])
{
    argList::addNote("EasyCFD browser: OpenFOAM SIMPLE / kOmegaSST, serial, double precision.");
    #include "setRootCase.H"
    #include "createTime.H"
    #include "createMesh.H"
    simpleControl simple(mesh);
    #include "createFields.H"
    #include "initContinuityErrs.H"
    turbulence->validate();

    IOdictionary cfg(IOobject("easycfdDict",runTime.system(),mesh,IOobject::MUST_READ,IOobject::NO_WRITE));
    const scalar rho=cfg.get<scalar>("rho"), speed=cfg.get<scalar>("speed"), area=cfg.get<scalar>("area");
    const vector origin(cfg.get<vector>("origin"));
    const wordList names(cfg.get<wordList>("patches"));
    const label snapshotInterval=cfg.getOrDefault<label>("snapshotInterval",50);
    labelList patches(names.size());
    forAll(names,i)
    {
        patches[i]=mesh.boundaryMesh().findPatchID(names[i]);
        if (patches[i]<0 || mesh.boundary()[patches[i]].size()<6)
            FatalErrorInFunction<< "Car part " << names[i] << " is missing or unresolved. Use Fast or the server engine." << exit(FatalError);
    }
    const fileName outDir(runTime.path()/"easycfd");
    mkDir(outDir);
    std::ofstream history((outDir/"history.tsv").c_str());
    history << std::setprecision(14);
    Info<< "EASYCFD_CELLS " << mesh.nCells() << endl;
    const scalar qA=.5*rho*sqr(speed)*area;

    // Per-patch pressure / friction forces and moments, one row per iteration.
    // Same expression as OpenFOAM's forces functionObject for incompressible RANS.
    while (simple.loop())
    {
        Info<< "Time = " << runTime.timeName() << nl << endl;
        {
            #include "UEqn.H"
            #include "pEqn.H"
        }
        laminarTransport.correct();
        turbulence->correct();
        runTime.write();

        tmp<volTensorField> gradU=fvc::grad(U);
        vector force(Zero), moment(Zero);
        history << runTime.timeIndex();
        forAll(patches,i)
        {
            const label patch=patches[i];
            const vectorField& sf=mesh.Sf().boundaryField()[patch];
            const vectorField md(mesh.C().boundaryField()[patch]-origin);
            const vectorField fp(rho*sf*p.boundaryField()[patch]);
            const vectorField fv(sf & (-rho*turbulence->nuEff(patch)*devTwoSymm(gradU().boundaryField()[patch])));
            const vector pressure=sum(fp), friction=sum(fv);
            const vector pm=sum(md^fp), fm=sum(md^fv);
            force+=pressure+friction; moment+=pm+fm;
            for (const vector v : {pressure,friction,pm,fm})
                for (direction c=0;c<3;++c) history << '\t' << v[c];
        }
        history << '\n'; history.flush();
        Info<< "EASYCFD_FORCE " << runTime.timeIndex() << ' ' << force.x()/qA << ' ' << force.z()/qA << ' ' << force.y()/qA
            << ' ' << force.x() << ' ' << force.y() << ' ' << force.z()
            << ' ' << moment.x() << ' ' << moment.y() << ' ' << moment.z() << endl;

        if (snapshotInterval>0 && runTime.timeIndex()%snapshotInterval==0)
        {
            sampleVolume(mesh,U,p,turbulence->k()(),cfg,outDir/"field.bin");
            Info<< "EASYCFD_FIELD " << runTime.timeIndex() << endl;
        }
        runTime.printExecutionTime(Info);
    }
    sampleVolume(mesh,U,p,turbulence->k()(),cfg,outDir/"field.bin");

    tmp<volTensorField> gradU=fvc::grad(U);
    // Face centres, outward fluid normals, Cp, fluid traction (Pa), near-wall U, area.
    forAll(patches,i)
    {
        const label patch=patches[i];
        std::ofstream out((outDir/(names[i]+".bin")).c_str(),std::ios::binary);
        const auto& faceCentres=mesh.C().boundaryField()[patch];
        const auto& sf=mesh.Sf().boundaryField()[patch];
        const auto& magSf=mesh.magSf().boundaryField()[patch];
        const vectorField traction((sf/magSf) & (-rho*turbulence->nuEff(patch)*devTwoSymm(gradU().boundaryField()[patch])));
        const vectorField nearU(U.boundaryField()[patch].patchInternalField());
        forAll(faceCentres,f)
        {
            writeVector(out,faceCentres[f]); writeVector(out,sf[f]/magSf[f]);
            writeFloat(out,p.boundaryField()[patch][f]/(.5*sqr(speed)));
            writeVector(out,traction[f]); writeVector(out,nearU[f]);
            writeFloat(out,magSf[f]);
        }
    }
    Info<< "EASYCFD_DONE " << runTime.timeIndex() << endl;
    return 0;
}
