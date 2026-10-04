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

## Run locally

Use Node.js 22 and npm.

```sh
cd web
npm ci
npm run dev
```

OpenFOAM is an optional local engine. It is not connected to the public app. See the [technical guide](TECHNICAL_GUIDE.md) for local setup, model preparation, solver options, and development checks.
