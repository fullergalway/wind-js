/*  Global class for simulating the movement of particle through a 1km wind grid

    credit: All the credit for this work goes to: https://github.com/cambecc for creating the repo:
      https://github.com/cambecc/earth. The majority of this code is directly take nfrom there, since its awesome.

    This class takes a canvas element and an array of data (1km GFS from http://www.emc.ncep.noaa.gov/index.php?branch=GFS)
    and then uses a mercator (forward/reverse) projection to correctly map wind vectors in "map space".

    The "start" method takes the bounds of the map at its current extent and starts the whole gridding,
    interpolation and animation process.
*/

var Windy = function( params ){
  var VELOCITY_SCALE = .011;             // scale for wind velocity (completely arbitrary--this value looks nice)
  var INTENSITY_SCALE_STEP = 0.05;            // step size of particle intensity color scale
  var MAX_WIND_INTENSITY = .75;              // wind velocity at which particle intensity is maximum (m/s)
  var MAX_PARTICLE_AGE = 50;                // max number of frames a particle is drawn before regeneration
  var PARTICLE_LINE_WIDTH = 1;              // line width of a drawn particle
  var PARTICLE_MULTIPLIER = 1/1000;              // particle count scalar (completely arbitrary--this values looks nice)
  var PARTICLE_REDUCTION = 0.75;            // reduce particle count to this much of normal for mobile devices
  var TIMELAPSE_FRAMES = 1440;
  var TIMELAPSE_STEP = 1;
	var CURRENT_STEP = 0;
	var PAUSED = false;
	var STOPPED = false;

  var NULL_WIND_VECTOR = [NaN, NaN, null];  // singleton for no wind in the form: [u, v, magnitude]

  var τ = 2 * Math.PI;
  var H = Math.pow(10, -5.2);

  // interpolation for vectors like wind (u,v,m)
  var bilinearInterpolateVector = function(x, y, g00, g10, g01, g11, arr) {
      var rx = (1 - x);
      var ry = (1 - y);
      var a = rx * ry,  b = x * ry,  c = rx * y,  d = x * y;
      var u = g00[0] * a + g10[0] * b + g01[0] * c + g11[0] * d;
      var v = g00[1] * a + g10[1] * b + g01[1] * c + g11[1] * d;
			arr[0] = u;
			arr[1] = v;
			arr[2] = Math.sqrt(u * u + v * v)
      return arr;
  };


  var createWindBuilder = function(uComp, vComp, steps) {
    var start_date = new Date(uComp[0].header.refTime);
    start_date.setHours(start_date.getHours() + uComp[0].header.forecastTime);
    var end_date = new Date(uComp[uComp.length-1].header.refTime);
    end_date.setHours(end_date.getHours() + uComp[uComp.length-1].header.forecastTime);

      var obj = function(){

      };
      obj.prototype.header =uComp[0].header;
      obj.prototype.interpolate = bilinearInterpolateVector;
      obj.prototype.start_date = start_date;
      obj.prototype.end_date = end_date;
      obj.prototype._progress = function(t){
        if(this._cached_t !== t){
          this._cached_t = t;
          var p = (t % steps)/steps * (uComp.length-1), p0 = ~~p, p1 = p - p0;
          var q = p0 == (uComp.length-1)? p0: p0+1;
          this._cached_v = {
            p: p,
            p0: p0,
            p1: p1,
            p2: 1-p1,
            q: q
          };
        }
        return this._cached_v;
      }
      obj.prototype._data = function(i,t,arr){
        var p = this._progress(t);
				arr[0] = uComp[p.p0].data[i]*p.p2+uComp[p.q].data[i]*(p.p1);
				arr[1] = vComp[p.p0].data[i]*p.p2+vComp[p.q].data[i]*(p.p1);
        return arr;
      };
      obj.prototype.data = function data(i) {
          return this._data.bind(this,i);
      };
      return new obj();

  };

  var createBuilder = function(data) {
      var uComp = [], vComp = [], scalar = null;

      data.forEach(function(record) {
          switch (record.header.parameterCategory + "," + record.header.parameterNumber) {
              case "2,2": uComp.push(record); break;
              case "2,3": vComp.push(record); break;
              default:
                scalar = record;
          }
      });

      return createWindBuilder.bind(null, uComp, vComp, TIMELAPSE_FRAMES)();
  };

  var buildGrid = function(data, callback) {
      columns = [];
      var builder = createBuilder(data);

      var header = builder.header;
      var λ0 = header.lo1, φ0 = header.la1;  // the grid's origin (e.g., 0.0E, 90.0N)
      var Δλ = header.dx, Δφ = header.dy;    // distance between grid points (e.g., 2.5 deg lon, 2.5 deg lat)
      var ni = header.nx, nj = header.ny;    // number of grid points W-E and N-S (e.g., 144 x 73)

      // Scan mode 0 assumed. Longitude increases from λ0, and latitude decreases from φ0.
      // http://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_table3-4.shtml
      var grid = [], p = 0;
      var isContinuous = Math.floor(ni * Δλ) >= 360;
      for (var j = 0; j < nj; j++) {
          var row = [];
          for (var i = 0; i < ni; i++) {
              row[i] = builder.data((j*ni)+i);
          }
          if (isContinuous) {
              // For wrapped grids, duplicate first column as last column to simplify interpolation logic
              row.push(row[0]);
          }
          grid[j] = row;
      }
      var buf0=[],buf1=[],buf2=[],buf3=[];
      function interpolate(λ, φ, t, buf) {
          t = t || 0;
          var i = floorMod(λ - λ0, 360) / Δλ;  // calculate longitude index in wrapped range [0, 360)
          var j = (φ0 - φ) / Δφ;                 // calculate latitude index in direction +90 to -90

          var fi = Math.floor(i), ci = fi + 1;
          var fj = Math.floor(j), cj = fj + 1;

          var row;
          if ((row = grid[fj]) && row[fi] && row[ci]) {
              var g00 = row[fi](t,buf0); //grid(fj,fi,t);
              var g10 = row[ci](t,buf1); //grid(fj,ci,t);
              if (isValue(g00) && isValue(g10) && ((row = grid[cj])) && row[fi] && row[ci]) {
                  var g01 = row[fi](t,buf2);//grid(cj,fi,t);
                  var g11 = row[ci](t,buf3);//grid(cj,ci,t);
                  if (isValue(g01) && isValue(g11)) {
                      // All four points found, so interpolate the value.
                      return builder.interpolate(i - fi, j - fj, g00, g10, g01, g11, buf);
                  }
              }
          }
          return null;
      }
      callback( {
          date: builder.start_date,
          start_date: builder.start_date,
          end_date: builder.end_date,
          interpolate: interpolate
      });
  };



  /**
   * @returns {Boolean} true if the specified value is not null and not undefined.
   */
  var isValue = function(x) {
      return x !== null && x !== undefined;
  }

  /**
   * @returns {Number} returns remainder of floored division, i.e., floor(a / n). Useful for consistent modulo
   *          of negative numbers. See http://en.wikipedia.org/wiki/Modulo_operation.
   */
  var floorMod = function(a, n) {
      return a - n * Math.floor(a / n);
  }

  /**
   * @returns {Number} the value x clamped to the range [low, high].
   */
  var clamp = function(x, range) {
      return Math.max(range[0], Math.min(x, range[1]));
  }

  /**
   * @returns {Boolean} true if agent is probably a mobile device. Don't really care if this is accurate.
   */
  var isMobile = function() {
      return (/android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i).test(navigator.userAgent);
  }

  /**
   * Calculate distortion of the wind vector caused by the shape of the projection at point (x, y). The wind
   * vector is modified in place and returned by this function.
   */
  var distort = function(λ, φ, x, y, scale, wind, windy) {
      if(!wind){
        return NULL_WIND_VECTOR;
      }
      var u = wind[0] * scale;
      var v = wind[1] * scale;
      var d = distortion(λ, φ, x, y, windy);

      // Scale distortion vectors by u and v, then add.
      wind[0] = d[0] * u + d[2] * v;
      wind[1] = d[1] * u + d[3] * v;
      return wind;
  };

  var distortion = function(λ, φ, x, y, windy) {
      var τ = 2 * Math.PI;
      var H = Math.pow(10, -5.2);
      var hλ = λ < 0 ? H : -H;
      var hφ = φ < 0 ? H : -H;

      var pλ = project(φ, λ + hλ,windy);
      var pφ = project(φ + hφ, λ, windy);

      // Meridian scale factor (see Snyder, equation 4-3), where R = 1. This handles issue where length of 1º λ
      // changes depending on φ. Without this, there is a pinching effect at the poles.
      var k = Math.cos(φ / 360 * τ);
      return [
          (pλ[0] - x) / hλ / k,
          (pλ[1] - y) / hλ / k,
          (pφ[0] - x) / hφ,
          (pφ[1] - y) / hφ
      ];
  };



  var createField = function(columns, bounds, callback) {

      /**
       * @returns {Array} wind vector [u, v, magnitude] at the point (x, y), or [NaN, NaN, null] if wind
       *          is undefined at that point.
       */
      function field(x, y, t, arr) {
          var column = columns[Math.round(x)];
          var iy = Math.round(y);
          if(column && column[iy]){
            return column[iy](t,arr);
          }
          return NULL_WIND_VECTOR;
      }

      // Frees the massive "columns" array for GC. Without this, the array is leaked (in Chrome) each time a new
      // field is interpolated because the field closure's context is leaked, for reasons that defy explanation.
      field.release = function() {
          columns = [];
      };

      field.randomize = function(o) {  // UNDONE: this method is terrible
          var x, y, t=0, buf=[];
          var safetyNet = 0;
          do {
              x = Math.round(Math.floor(Math.random() * bounds.width) + bounds.x);
              y = Math.round(Math.floor(Math.random() * bounds.height) + bounds.y)
          } while (field(x, y, t, buf)[2] === null && safetyNet++ < 0);
          o.x = x;
          o.y = y;
          return o;
      };

      //field.overlay = mask.imageData;
      //return field;
      callback( bounds, field );
  };

  var buildBounds = function( bounds, width, height ) {
      var upperLeft = bounds[0];
      var lowerRight = bounds[1];
      var x = Math.round(upperLeft[0]); //Math.max(Math.floor(upperLeft[0], 0), 0);
      var y = Math.max(Math.floor(upperLeft[1], 0), 0);
      var xMax = Math.min(Math.ceil(lowerRight[0], width), width - 1);
      var yMax = Math.min(Math.ceil(lowerRight[1], height), height - 1);
      return {x: x, y: y, xMax: width, yMax: yMax, width: width, height: height};
  };

  var deg2rad = function( deg ){
    return (deg / 180) * Math.PI;
  };

  var rad2deg = function( ang ){
    return ang / (Math.PI/180.0);
  };

  var invert = function(x, y, windy){
    var mapLonDelta = windy.east - windy.west;
    var worldMapRadius = windy.width / rad2deg(mapLonDelta) * 360/(2 * Math.PI);
    var mapOffsetY = ( worldMapRadius / 2 * Math.log( (1 + Math.sin(windy.south) ) / (1 - Math.sin(windy.south))  ));
    var equatorY = windy.height + mapOffsetY;
    var a = (equatorY-y)/worldMapRadius;

    var lat = 180/Math.PI * (2 * Math.atan(Math.exp(a)) - Math.PI/2);
    var lon = rad2deg(windy.west) + x / windy.width * rad2deg(mapLonDelta);
    return [lon, lat];
  };

  var mercY = function( lat ) {
    return Math.log( Math.tan( lat / 2 + Math.PI / 4 ) );
  };


  var project = function( lat, lon, windy) { // both in radians, use deg2rad if neccessary
    var ymin = mercY(windy.south);
    var ymax = mercY(windy.north);
    var xFactor = windy.width / ( windy.east - windy.west );
    var yFactor = windy.height / ( ymax - ymin );

    var y = mercY( deg2rad(lat) );
    var x = (deg2rad(lon) - windy.west) * xFactor;
    var y = (ymax - y) * yFactor; // y points south
    return [x, y];
  };


  var interpolateField = function( grid, bounds, extent, callback ) {
    var velocityScale = VELOCITY_SCALE;

    var columns = [];
    var x = bounds.x;
    var wind_obj = function(λ, φ, x, y){
      this.λ = λ;
      this.φ = φ;
      this.x = x;
      this.y = y;
    };
    wind_obj.prototype.fn = function(t,arr){
      t = t || 0;
      if(this.memoized_t !== t){
        this.memoized_t = t;
        var wind = grid.interpolate(this.λ, this.φ, t,arr);
        this.memoized_v = distort(this.λ, this.φ, this.x, this.y, velocityScale, wind, extent);
      }
      return this.memoized_v;
    };

    function interpolateColumn(x) {
        var column = [];
        for (var y = bounds.y; y <= bounds.yMax; y += 2) {
                var coord = invert( x, y, extent );
                if (coord) {
                    var λ = coord[0], φ = coord[1];
                    if (isFinite(λ)) {
                       var obj = new wind_obj(λ, φ, x, y);
                       column[y+1] = column[y] = obj.fn.bind(obj);
                    }
                }
        }
        columns[x+1] = columns[x] = column;
    }

    (function batchInterpolate() {
                var start = Date.now();
                while (x < bounds.width) {
                    interpolateColumn(x);
                    x += 2;
                    if ((Date.now() - start) > 1000) { //MAX_TASK_TIME) {
                        setTimeout(batchInterpolate, 25);
                        return;
                    }
                }
          createField(columns, bounds, callback);
    })();
  };

	var time_change_listeners = [];

  var animate = function(bounds, field, start_date, end_date) {

    function asColorStyle(r, g, b, a) {
        return "rgba(" + 243 + ", " + 243 + ", " + 238 + ", " + a + ")";
    }

    function hexToR(h) {return parseInt((cutHex(h)).substring(0,2),16)}
    function hexToG(h) {return parseInt((cutHex(h)).substring(2,4),16)}
    function hexToB(h) {return parseInt((cutHex(h)).substring(4,6),16)}
    function cutHex(h) {return (h.charAt(0)=="#") ? h.substring(1,7):h}

    function windIntensityColorScale(step, maxWind) {

        var result = [
          "rgba(" + hexToR('#00ffff') + ", " + hexToG('#00ffff') + ", " + hexToB('#00ffff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#64f0ff') + ", " + hexToG('#64f0ff') + ", " + hexToB('#64f0ff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#87e1ff') + ", " + hexToG('#87e1ff') + ", " + hexToB('#87e1ff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#a0d0ff') + ", " + hexToG('#a0d0ff') + ", " + hexToB('#a0d0ff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#b5c0ff') + ", " + hexToG('#b5c0ff') + ", " + hexToB('#b5c0ff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#c6adff') + ", " + hexToG('#c6adff') + ", " + hexToB('#c6adff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#d49bff') + ", " + hexToG('#d49bff') + ", " + hexToB('#d49bff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#e185ff') + ", " + hexToG('#e185ff') + ", " + hexToB('#e185ff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#ec6dff') + ", " + hexToG('#ec6dff') + ", " + hexToB('#ec6dff') + ", " + 0.5 + ")",
          "rgba(" + hexToR('#ff1edb') + ", " + hexToG('#ff1edb') + ", " + hexToB('#ff1edb') + ", " + 0.5 + ")"
        ]
        result.indexFor = function(m) {  // map wind speed to a style
            return Math.floor(Math.min(m, maxWind) / maxWind * (result.length - 1));
        };
        return result;
    }

    var colorStyles = windIntensityColorScale(INTENSITY_SCALE_STEP, MAX_WIND_INTENSITY);
    var buckets = colorStyles.map(function() { return []; });
    var start_time = start_date.getTime();
    var display_time = new Date();
    display_time.setTime(start_time);
    var duration = end_date.getTime()-start_date.getTime();

    var particleCount = Math.round(bounds.width * bounds.height * PARTICLE_MULTIPLIER);
    if (isMobile()) {
      particleCount *= PARTICLE_REDUCTION;
    }

    var fadeFillStyle = "rgba(0, 0, 0, 0.95)";

    var particles = [];
		var fieldBuf = [];
		var resetParticles = function(){
			particles = [];
			for (var i = 0; i < particleCount; i++) {
	        particles.push(field.randomize({age: Math.floor(Math.random() * MAX_PARTICLE_AGE) + 0}));
	    }
		}
		resetParticles();

    function evolve() {
			var t = CURRENT_STEP;
			if(!PAUSED){
				CURRENT_STEP += TIMELAPSE_STEP;
	      if(CURRENT_STEP >= TIMELAPSE_FRAMES){
	        CURRENT_STEP = 0;
					resetParticles();
	      }
				t = CURRENT_STEP<0?0:CURRENT_STEP>=TIMELAPSE_FRAMES?TIMELAPSE_FRAMES-1:CURRENT_STEP;
				display_time.setTime(start_time+(t/TIMELAPSE_FRAMES-1)*duration);
				for(var i=0;i<time_change_listeners.length;i++){
						setTimeout(time_change_listeners[i].bind(null,display_time.getTime()),0);
				}
			}
      buckets.forEach(function(bucket) { bucket.length = 0; });
			var fieldBuf = [];
      for(var i=particles.length-1;i>0;i--){
        var particle = particles[i];
        if (particle.age >= MAX_PARTICLE_AGE) {
          field.randomize(particle).age =  0;
        }
        var x = particle.x;
        var y = particle.y;
        var v = field(x, y, t, fieldBuf);  // vector at current position and time
        var m = v[2];
        if (m === null) {
          particle.age = MAX_PARTICLE_AGE;  // particle has escaped the grid, never to return...
        }
        else {
          var xt = x + v[0];
          var yt = y + v[1];
          if (field(xt, yt, t, fieldBuf)[2] !== null) {

            // Path from (x,y) to (xt,yt) is visible, so add this particle to the appropriate draw bucket.
            particle.xt = xt;
            particle.yt = yt;
            buckets[colorStyles.indexFor(m)].push(particle);
          }
          else {
            // Particle isn't visible, but it still moves through the field.
            particle.x = xt;
            particle.y = yt;
          }
        }

        particle.age += 1;
      }
    }

    var g = params.canvas.getContext("2d");
    g.lineWidth = PARTICLE_LINE_WIDTH;
    g.fillStyle = fadeFillStyle;

    function draw() {
        // Fade existing particle trails.

        var prev = g.globalCompositeOperation;
        g.globalCompositeOperation = "destination-in";
        g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        g.globalCompositeOperation = prev;

        // Draw new particle trails.
        buckets.forEach(function(bucket, i) {
            if (bucket.length > 0) {
                g.beginPath();
                g.strokeStyle = colorStyles[i];
                bucket.forEach(function(particle) {
                    g.moveTo(particle.x, particle.y);
                    g.lineTo(particle.xt, particle.yt);
                    particle.x = particle.xt;
                    particle.y = particle.yt;
                });
                g.stroke();
            }
        });
    }

    (function frame() {
        try {
							if(STOPPED){
								return;
							}
              requestAnimationFrame(frame);
              evolve();
              draw();
              if(window.capturer){
                window.capturer.capture(params.canvas);
              }
        }
        catch (e) {
            console.error(e);
        }
    })();
  }

  var pause = function(){
		PAUSED = true;
	}
	var play = function(){
		PAUSED = false;
	}
  var start = function( bounds, width, height, extent ){
    var mapBounds = {
      south: deg2rad(extent[0][1]),
      north: deg2rad(extent[1][1]),
      east: deg2rad(extent[1][0]),
      west: deg2rad(extent[0][0]),
      width: width,
      height: height
    };

    stop();
		STOPPED = false;

    // build grid
    buildGrid( params.data, function(grid){
      // interpolateField
      interpolateField( grid, buildBounds( bounds, width, height), mapBounds, function( bounds, field ){
        // animate the canvas with random points
        windy.field = field;
        animate( bounds, field, grid.start_date, grid.end_date );
      });

    });
  };

  var stop = function(){
		STOPPED = true;
  };


  var windy = {
    params: params,
    start: start,
    stop: stop,
		pause: pause,
		play: play,
		onTimeChange: function(cb){
			time_change_listeners.push(cb);
		}
  };

  return windy;
}



// shim layer with setTimeout fallback
window.requestAnimationFrame = (function(){
  return  window.requestAnimationFrame       ||
          window.webkitRequestAnimationFrame ||
          window.mozRequestAnimationFrame    ||
          window.oRequestAnimationFrame ||
          window.msRequestAnimationFrame ||
          function( callback ){
            window.setTimeout(callback, 1000 / 20);
          };
})();
