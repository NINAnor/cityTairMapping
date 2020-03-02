// Author: Zander Venter - zander.venter@nina.no

// This code is a lightweight version of the air temperature (Tair) mapping procedure 
// submitted to Remote Sensing of the Environment 2020
// here we use only Sentinel data given that there is little difference in model
// accuracy when using Landsat data instead

// Workflow:
  // 1. Ingest a dataframe of Netatmo Tair measurements
  // 2. Collect predictor variables from terrain and Sentinel datasets
  // 3. Train a Random Forest model and predict Tair on-the-fly


/*
  // Global Objects ///////////////////////////////////////////////////////////////////
*/
// Bring in Netatmo station dataframe with temperature values you want to model
  // These may be annual, monthly or daily Tair min, max or mean - whatever you want
  // You can use the example dataset as an example
  // Or ingest your own into GEE as CSV with Lat-Lon columns as geometry
var netatmo = ee.FeatureCollection("users/zandersamuel/NINA/Vector/p_netatmo_dummy_GEE");


// Define name of response Tair variable
var response = 'ta';

// Define name of station ID variable
var ID = 'ID'

// Estimate of min & max temperature for your area and time period 
// for visualization later on
var minTemp = 7;
var maxTemp = 10;

// Define are of interest - needs to overlap Netatmo stations
var aoi = netatmo;

// Define time range of interest
  // Needs to overlap netatmo time frame
  // Smaller periods might cause an error due to cloud contamination
  // Suggestion is to calculate for minimum of 2 month mean
  // Unless you know of a specific date with cloud-free Sentinel image
var startDate = '2018-01-01';
var endDate = '2018-02-01';

// Palettes for visualization
var virdis = '440154,472878,3E4A89,31688E,25838E,1E9E89,35B779,6CCE59,B5DE2C,FDE725';
var thpalette = ['330066','0000cc','33ccff','e6e600','ff9900','ff0000'];


//// Netatmo data checking --------------------------------------------

// Add to map to explore coverage
Map.addLayer(netatmo, {}, 'netatmo stations', 0);

// Center map over netatmo data
Map.centerObject(netatmo)

// Check to see how many stations there are by printing unique IDs
var IDs = netatmo.distinct([ID]).reduceColumns(ee.Reducer.toList(), [ID]);
print('Netatmo station IDs: ', IDs);

/*
  // Global Functions ///////////////////////////////////////////////////////////////////
*/
// Function to create terrain ruggedness layer
var makeRugged = function(img){
  var kernel = ee.Kernel.square(1.5);
  var neighbors = img.neighborhoodToBands(kernel);
  var diff = img.subtract(neighbors);
  var sq = diff.multiply(diff);
  return sq.reduce(ee.Reducer.sum()).sqrt();
};

// Funciton to resample neighborhoods
function resample(image, method, projection){
  var output = image
    .reduceResolution({
      reducer: method,
      maxPixels: 1024
    })
    .reproject(projection);
  return output
}

// Function to mask clouds using the Sentinel-2 QA band.
function maskS2clouds(img) {
  var qa = img.select('QA60').int16();
  var cloudBitMask = Math.pow(2, 10);
  var cirrusBitMask = Math.pow(2, 11);
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0).and(
             qa.bitwiseAnd(cirrusBitMask).eq(0));
  return img.updateMask(mask);
}

// Function to add spectral indices to Sentinel images
var addIndices = function(image) {
  var ndbi = image.expression(
    '(SWIR - NIR) / (SWIR + NIR)', {
      'SWIR': image.select('swir1'),
      'NIR': image.select('nir'),
    }).rename('NDBI');
  // Add vegetation indices
  var ndvi = image.normalizedDifference(['nir', 'red']).rename('ndvi')
  return image.addBands(ndvi).addBands(ndbi)
};

//This procedure must be used for proper processing of S2 imagery
function uniqueValues(collection,field){
    var values  =ee.Dictionary(collection.reduceColumns(ee.Reducer.frequencyHistogram(),[field]).get('histogram')).keys();
    return values;
  }
function dailyMosaics(imgs){
  //Simplify date to exclude time of day
  imgs = imgs.map(function(img){
  var d = ee.Date(img.get('system:time_start'));
  var day = d.get('day');
  var m = d.get('month');
  var y = d.get('year');
  var simpleDate = ee.Date.fromYMD(y,m,day);
  return img.set('simpleTime',simpleDate.millis());
  });
  
  //Find the unique days
  var days = uniqueValues(imgs,'simpleTime');
  
  imgs = days.map(function(d){
    d = ee.Number.parse(d);
    d = ee.Date(d);
    var t = imgs.filterDate(d,d.advance(1,'day'));
    var f = ee.Image(t.first());
    t = t.mosaic();
    t = t.set('system:time_start',d.millis());
    t = t.copyProperties(f);
    return t;
    });
    imgs = ee.ImageCollection.fromImages(imgs);
    
    return imgs;
}

// Create a function to buffer each netatmo station by given radius
function makeBuf(collection, radius){
  collection = collection.map(function(ft){return ft.buffer(radius).set('buffer', radius)});
  return collection;
}

// Create a function to mask water using GLOBLAND30
function maskWater(image){
  var glc_coll = ee.ImageCollection('users/cgmorton/GlobeLand30');
  var glc_img = ee.Image(glc_coll.mosaic());
  var waterMask = glc_img.neq(60).and(glc_img.neq(255));
  return image.updateMask(waterMask)
}


/*
  // Gather Predictors ///////////////////////////////////////////////////////////////////
*/
//// Terrain -------------------------------------------------
// Using two terrain datasets to get coverage in high latitudes as well
var glob = ee.Image("USGS/GMTED2010").rename('elevation')
var srtm = ee.Image('USGS/SRTMGL1_003').rename('elevation')
var elev = srtm.unmask(glob)

// Calculate slope
var ter = ee.Algorithms.Terrain(elev);
ter = ter.select(['elevation', 'slope']);
Map.addLayer(ter.select('elevation'), {min:0, max:400, palette:virdis}, 'elevation', 0)
Map.addLayer(ter.select('slope'), {min:0, max:10, palette:virdis}, 'slope', 0)

// Calculate ruggedness index
var rugged = makeRugged(ter.select('elevation')).rename('elev_rugged');
Map.addLayer(rugged, {min:0, max:100, palette:virdis}, 'ruggedness', 0)


// Stack into one image
var terrainStack = ter
  .addBands(rugged);
print( 'Terrain stack predictors: ', terrainStack);

//// Dist to coast ---------------------------------------------
// Calculate distance to coast using GLOBLAND30 dataset
  // http://www.globallandcover.com/GLC30Download/index.aspx
var glc_coll = ee.ImageCollection('users/cgmorton/GlobeLand30');
var inProj = glc_coll.first().projection();
var glc_img = ee.Image(glc_coll.mosaic()).divide(ee.Image(10));
var water = glc_img.eq(25.5);
Map.addLayer(water, {}, 'water', 0)

// Euclidean distance from all pixels with value 1
var dist = water.fastDistanceTransform(1040).sqrt()
  .multiply(ee.Image.pixelArea().sqrt()).divide(1000);
//dist = dist.reproject(inProj.atScale(50))
var distCoast = dist.rename('distCoast');
Map.addLayer(distCoast, {max:0, min:12, palette:virdis}, 'dist to coast', 0);

//// Sentinel 2 SR ---------------------------------------------
var sentinel2 = ee.ImageCollection('COPERNICUS/S2_SR')
  .filterDate(startDate, endDate)
  .filterBounds(aoi)
  .filterMetadata('CLOUDY_PIXEL_PERCENTAGE', 'less_than', 30)
  .map(maskS2clouds)
  .select(['B2','B3','B4','B8', 'B11','B12'],
          ['blue', 'green', 'red','nir','swir1', 'swir2'])
  .map(addIndices);

// Clean duplicate images
sentinel2 = dailyMosaics(sentinel2);

// Reduce to median value
var sentStack = sentinel2.median();

print('Sentinel stack predictors: ', sentStack)
Map.addLayer(sentStack, {bands:['red','green','blue'], max:0, min:3000}, 'Sentinel 2', 0);

//// Combined all predictors ---------------------------------------------
var predictorStack = terrainStack
  //.addBands(distCoast) // I am leaving this out because it takes a lot of time to 
    //compute and not a very important predictor
  .addBands(sentStack);
var predictors = predictorStack.bandNames();
print('--------- Combined predictor stack names: ', predictors);

/*
  // Random Forest training and prediction ///////////////////////////////////////////////////////////////////
*/
//// Prepare training dataset ------------------------------------------------
// First extract predictor variables for each Netatmo station
  // Here I use a 200m radius buffer which gives most accurate results
var netatmoBuff =  makeBuf(netatmo, 100);

var trainingFeats = predictorStack.reduceRegions({
  collection: netatmoBuff, 
  reducer: ee.Reducer.mean(), 
  scale: 30,
  tileScale: 4
});
print(trainingFeats)


//// Prepare raster stack for prediction ----------------------------------------
// Now we apply a focal_mean which calculates the mean within Xm neighborhood of each pixel
  // This is the same as calculating mean value wihtin buffer zone of each station point
  // except it is doing it for every pixel so that we can predict over entire raster
predictorStack = predictorStack.focal_mean(100,'circle','meters');


//// Train Random Forest model ------------------------------------------------
// Build RF classifier in "REGRESSION" mode
var classifier = ee.Classifier.randomForest({
    numberOfTrees: 50
  }).setOutputMode('REGRESSION')
  .train({
  features: trainingFeats, 
  classProperty: response, 
  inputProperties: predictors
});

// Predict with Random Forest model -------------------------------------------
var classified = predictorStack.classify(classifier);

// mask water
classified = maskWater(classified);

Map.addLayer(classified, {min:minTemp, max:maxTemp, palette:thpalette}, 'Prediction', 0)

/*
  // Export results ///////////////////////////////////////////////////////////////////////////////
*/
Export.image.toDrive({
  image: classified, 
  description: 'Tair_prediction', 
  region: aoi.geometry().bounds(),
  scale: 30,
  maxPixels: 1e10
});

