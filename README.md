# EasyCFD

Explore airflow around a car or a part. Compare drag, downforce, and design changes in a browser wind tunnel.

[**Open EasyCFD**](https://easy-cfd.mthracelab.com/)

![EasyCFD: car airflow and simulation results](docs/easycfd-web.png)

## Start here

1. Load the sample car, or import an STL, OBJ, GLB, or glTF model.
2. Check the model's units and orientation. Set the speed and yaw angle.
3. Run a simulation. Inspect the results and airflow. Compare two runs to study a change.

The public app uses WebGPU. It needs a browser and device with WebGPU support. It stores projects in your browser.

Treat the results as exploratory estimates. They do not establish real vehicle loads or aerodynamic accuracy. Read the [validation notes](web/VALIDATION.md) before you use the numbers for a design decision.

## Learn car aerodynamics

Use **Aero course** in the app's top bar to open a self-contained four-day course. It starts with forces, pressure and boundary layers, then covers wings, splitters, canards, floors and diffusers, controlled CFD comparisons, axle balance and design tradeoffs. It includes 24 lessons, twelve labs, original diagrams, interactive calculations and actual exploratory EasyCFD run evidence. The [Guerrero et al. diffuser study](https://www.mdpi.com/2076-3417/12/8/3763) is a worked research case study.

The reading and calculators work offline and need no WebGPU. The lab button creates a separate teaching-car design; existing designs and runs stay in the library. **Save offline HTML** downloads the course, and **Print / PDF** prints the full reading with answers. The checked-in [review PDF](output/pdf/easycfd-car-aerodynamics.pdf) is generated from the same HTML. See the [course guide](docs/aerodynamics-course/README.md) for its source, reproduction and feature issues.

## Run locally

Use Node.js 22 and npm.

```sh
cd web
npm ci
npm run dev
```

OpenFOAM is an optional local engine. It is not connected to the public app. See the [technical guide](TECHNICAL_GUIDE.md) for local setup, model preparation, solver options, and development checks.
