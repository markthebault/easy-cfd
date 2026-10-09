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

## Aero overview

After a run, choose **Explore airflow → Aero overview** to see surface pressure and thin, speed-coloured streamlines around the car and through its wake. Each field has its own scale. Adjust the line density, thickness, colours and local wake seeds in Settings; PNG exports include both legends.

This view uses the saved steady velocity field. Wake detail depends on what the simulation resolves.

## Run locally

Use Node.js 22 and npm.

```sh
cd web
npm ci
npm run dev
```

OpenFOAM is an optional local engine. It is not connected to the public app. See the [technical guide](TECHNICAL_GUIDE.md) for local setup, model preparation, solver options, and development checks.

## Recorded airflow and local OpenFOAM runs

Enable **Record flow animation** to replay computed airflow in the 3D view. Standard recordings store 48 physical-time frames. The local OpenFOAM engine also offers **Detailed wake**: a dedicated mesh, DDES and approximately 192 frames on four dense sections. Select a section during playback; the selected section is saved for offline use. See [recording and video validation](docs/fine-airflow/README.md).

OpenFOAM analysis uses four cards: **Fast**, **Medium**, **Precise** (Advanced 1) and **Very Precise** (Advanced 2). Medium has a 20-minute whole-job ceiling including standard recording; unfinished results remain provisional or incomplete. The [measured Medium run](docs/medium-runtime.md) completed in 9 minutes on the tested model and machine. Detailed wake has a separate, longer budget.

In the library's **OpenFOAM server** tab, click a running or queued run to reopen its progress and saved car geometry. The run continues on the server when you close the browser.
