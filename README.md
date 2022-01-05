# cityTairMapping

Simplified scripts for the spatial interpolation of point air temperature (Tair) data from private weather stations using a Random Forest model with satellite and other predictor data. Methods published here: https://www.sciencedirect.com/science/article/pii/S0034425720301619

*DISCALIMER: this repo is not a comprehensive and functional workflow due to the use of three different programming platforms and movement of data between cloud and local environment. The onus is on the user to fill in the gaps where necessary.*

### Workflow:
1. **Collect Netatmo private weather station data**

The "Netatmo_data_fetch_template.ipynb" file is a Python notebook that can be run in Google Colab or similar to collect historical Tair data for Netatmo weather stations over an area of your choosing. You need to register a Netatmo developer account on the netatmo website in order to make calls to their API. Explore the [Netatmo weather map](https://weathermap.netatmo.com/) to get an idea for the station availability in your desired area. The data is exported to your Google Drive and you download from there to process it further locally in R.

2. **Clean and aggregate Netatmo Tair data**

The next step is to clean the Netatmo data for outliers and spurious measurements in R using the [CrowdQC](https://depositonce.tu-berlin.de/handle/11303/7520.3) package. There is enough documentation and sample scripts on this step already so I am not including sample scripts in this repo. Once the Netatmo data is cleaned, you aggregate it to some meaningful unit (e.g. mean annual Tair) per station to produce a dataframe that looks something like the "dummy_netatmo_GEE.csv" file. This file is then uploaded to [Google Earth Engine](https://earthengine.google.com/) where you can implement the machine learning phase.

3. **Map Tair over space using Random Forest and satellite data**

Once you have your cleaned and aggregated Tair data in Google Earth Engine (GEE), you can use the "Tair_mapping_GEE.js" file within GEE JavaScript API to interpolate/predict Tair over space. This script extracts satellite and terrain data for each Netatmo station, trains a Random Forest regression model, and then predicts the Tair over the entire study area. The output is a TIFF file exported to your Google Drive. 
