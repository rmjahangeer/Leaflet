/*
 * L.Map is the central class of the API - it is used to create a map.
 */

L.Map = L.Class.extend({

	includes: L.Mixin.Events,

	options: {
		crs: L.CRS.EPSG3857,

		/*
		center: LatLng,
		zoom: Number,
		layers: Array,
		*/

		fadeAnimation: L.DomUtil.TRANSITION && !L.Browser.android23,
		trackResize: true,
		markerZoomAnimation: true
	},

	initialize: function (id, options) { // (HTMLElement or String, Object)
		options = L.Util.setOptions(this, options);

		this._initContainer(id);
		this._initLayout();
		this._initHooks();
		this._initEvents();

		if (options.maxBounds) {
			this.setMaxBounds(options.maxBounds);
		}

		if (options.center && options.zoom !== undefined) {
			this.setView(options.center, options.zoom, true);
		}

		this._initLayers(options.layers);
	},


	// public methods that modify map state

	// replaced by animation-powered implementation in Map.PanAnimation.js
	setView: function (center, zoom) {
		this._resetView(center, this._limitZoom(zoom));
		return this;
	},

	setZoom: function (zoom) { // (Number)
		return this.setView(this.getCenter(), zoom);
	},

	zoomIn: function () {
		return this.setZoom(this._zoom + 1);
	},

	zoomOut: function () {
		return this.setZoom(this._zoom - 1);
	},

	fitBounds: function (bounds) { // (LatLngBounds)
		var zoom = this.getBoundsZoom(bounds);
		return this.setView(bounds.getCenter(), zoom);
	},

	fitWorld: function () {
		var sw = new L.LatLng(-60, -170),
		    ne = new L.LatLng(85, 179);

		return this.fitBounds(new L.LatLngBounds(sw, ne));
	},

	panTo: function (center) { // (LatLng)
		return this.setView(center, this._zoom);
	},

	panBy: function (offset) { // (Point)
		// replaced with animated panBy in Map.Animation.js
		this.fire('movestart');

		this._rawPanBy(offset);

		this.fire('move');
		return this.fire('moveend');
	},

	setMaxBounds: function (bounds) {
		this.options.maxBounds = bounds;

		if (!bounds) {
			this._boundsMinZoom = null;
			return this;
		}

		var minZoom = this.getBoundsZoom(bounds, true);

		this._boundsMinZoom = minZoom;

		if (this._loaded) {
			if (this._zoom < minZoom) {
				this.setView(bounds.getCenter(), minZoom);
			} else {
				this.panInsideBounds(bounds);
			}
		}

		return this;
	},

	panInsideBounds: function (bounds) {
		var viewBounds = this.getBounds(),
		    viewSw = this.project(viewBounds.getSouthWest()),
		    viewNe = this.project(viewBounds.getNorthEast()),
		    sw = this.project(bounds.getSouthWest()),
		    ne = this.project(bounds.getNorthEast()),
		    dx = 0,
		    dy = 0;

		if (viewNe.y < ne.y) { // north
			dy = ne.y - viewNe.y;
		}
		if (viewNe.x > ne.x) { // east
			dx = ne.x - viewNe.x;
		}
		if (viewSw.y > sw.y) { // south
			dy = sw.y - viewSw.y;
		}
		if (viewSw.x < sw.x) { // west
			dx = sw.x - viewSw.x;
		}

		return this.panBy(new L.Point(dx, dy, true));
	},

	addLayer: function (layer, insertAtTheBottom) {
		// TODO method is too big, refactor

		var id = L.Util.stamp(layer);

		if (this._layers[id]) { return this; }

		this._layers[id] = layer;

		// TODO getMaxZoom, getMinZoom in ILayer (instead of options)
		if (layer.options && !isNaN(layer.options.maxZoom)) {
			this._layersMaxZoom = Math.max(this._layersMaxZoom || 0, layer.options.maxZoom);
		}
		if (layer.options && !isNaN(layer.options.minZoom)) {
			this._layersMinZoom = Math.min(this._layersMinZoom || Infinity, layer.options.minZoom);
		}

		// TODO looks ugly, refactor!!!
		if (this.options.zoomAnimation && L.TileLayer && (layer instanceof L.TileLayer)) {
			this._tileLayersNum++;
            this._tileLayersToLoad++;
            layer.on('load', this._onTileLayerLoad, this);
		}

		var onMapLoad = function () {
			layer.onAdd(this, insertAtTheBottom);
			this.fire('layeradd', {layer: layer});
		};

		if (this._loaded) {
			onMapLoad.call(this);
		} else {
			this.on('load', onMapLoad, this);
		}

		return this;
	},

	removeLayer: function (layer) {
		var id = L.Util.stamp(layer);

		if (!this._layers[id]) { return; }

		layer.onRemove(this);

		delete this._layers[id];

		// TODO looks ugly, refactor
		if (this.options.zoomAnimation && L.TileLayer && (layer instanceof L.TileLayer)) {
			this._tileLayersNum--;
            this._tileLayersToLoad--;
            layer.off('load', this._onTileLayerLoad, this);
		}

		return this.fire('layerremove', {layer: layer});
	},

	hasLayer: function (layer) {
		var id = L.Util.stamp(layer);
		return this._layers.hasOwnProperty(id);
	},

	invalidateSize: function () {
		var oldSize = this.getSize();

		this._sizeChanged = true;

		if (this.options.maxBounds) {
			this.setMaxBounds(this.options.maxBounds);
		}

		if (!this._loaded) { return this; }

		var offset = oldSize.subtract(this.getSize()).divideBy(2, true);
		this._rawPanBy(offset);

		this.fire('move');

		clearTimeout(this._sizeTimer);
		this._sizeTimer = setTimeout(L.Util.bind(this.fire, this, 'moveend'), 200);

		return this;
	},

	// TODO handler.addTo
	addHandler: function (name, HandlerClass) {
		if (!HandlerClass) { return; }

		this[name] = new HandlerClass(this);

		if (this.options[name]) {
			this[name].enable();
		}

		return this;
	},


	// public methods for getting map state

	getCenter: function () { // (Boolean) -> LatLng
		return this.layerPointToLatLng(this._getCenterLayerPoint());
	},

	getZoom: function () {
		return this._zoom;
	},

	getBounds: function () {
		var bounds = this.getPixelBounds(),
		    sw = this.unproject(bounds.getBottomLeft()),
		    ne = this.unproject(bounds.getTopRight());
		
		return new L.LatLngBounds(sw, ne);
	},

	getMinZoom: function () {
		var z1 = this.options.minZoom || 0,
		    z2 = this._layersMinZoom || 0,
		    z3 = this._boundsMinZoom || 0;

		return Math.max(z1, z2, z3);
	},

	getMaxZoom: function () {
		var z1 = this.options.maxZoom === undefined ? Infinity : this.options.maxZoom,
		    z2 = this._layersMaxZoom  === undefined ? Infinity : this._layersMaxZoom;

		return Math.min(z1, z2);
	},

	getBoundsZoom: function (bounds, inside) { // (LatLngBounds, Boolean) -> Number
		var size = this.getSize(),
		    zoom = this.options.minZoom || 0,
		    maxZoom = this.getMaxZoom(),
		    ne = bounds.getNorthEast(),
		    sw = bounds.getSouthWest(),
		    boundsSize,
		    nePoint,
		    swPoint,
		    zoomNotFound = true;

		if (inside) {
			zoom--;
		}

		do {
			zoom++;
			nePoint = this.project(ne, zoom);
			swPoint = this.project(sw, zoom);
			boundsSize = new L.Point(Math.abs(nePoint.x - swPoint.x), Math.abs(swPoint.y - nePoint.y));

			if (!inside) {
				zoomNotFound = boundsSize.x <= size.x && boundsSize.y <= size.y;
			} else {
				zoomNotFound = boundsSize.x < size.x || boundsSize.y < size.y;
			}
		} while (zoomNotFound && zoom <= maxZoom);

		if (zoomNotFound && inside) {
			return null;
		}

		return inside ? zoom : zoom - 1;
	},

	getSize: function () {
		if (!this._size || this._sizeChanged) {
			this._size = new L.Point(
				this._container.clientWidth,
				this._container.clientHeight);

			this._sizeChanged = false;
		}
		return this._size;
	},

	getPixelBounds: function () {
		var topLeftPoint = this._getTopLeftPoint();
		return new L.Bounds(topLeftPoint, topLeftPoint.add(this.getSize()));
	},

	getPixelOrigin: function () {
		return this._initialTopLeftPoint;
	},

	getPanes: function () {
		return this._panes;
	},
	
	getContainer: function () {
		return this._container;
	},

	
	// TODO replace with universal implementation after refactoring projections

	getZoomScale: function (toZoom) {
		var crs = this.options.crs;
		return crs.scale(toZoom) / crs.scale(this._zoom);
	},

	getScaleZoom: function (scale) {
		return this._zoom + (Math.log(scale) / Math.LN2);
	},


	// conversion methods

	project: function (latlng, zoom) { // (LatLng[, Number]) -> Point
		zoom = zoom === undefined ? this._zoom : zoom;
		return this.options.crs.latLngToPoint(latlng, zoom);
	},

	unproject: function (point, zoom) { // (Point[, Number]) -> LatLng
		zoom = zoom === undefined ? this._zoom : zoom;
		return this.options.crs.pointToLatLng(point, zoom);
	},

	layerPointToLatLng: function (point) { // (Point)
		return this.unproject(point.add(this._initialTopLeftPoint));
	},

	latLngToLayerPoint: function (latlng) { // (LatLng)
		return this.project(latlng)._round()._subtract(this._initialTopLeftPoint);
	},

	containerPointToLayerPoint: function (point) { // (Point)
		return point.subtract(this._getMapPanePos());
	},

	layerPointToContainerPoint: function (point) { // (Point)
		return point.add(this._getMapPanePos());
	},

	containerPointToLatLng: function (point) {
		return this.layerPointToLatLng(this.containerPointToLayerPoint(point));
	},

	latLngToContainerPoint: function (latlng) {
		return this.layerPointToContainerPoint(this.latLngToLayerPoint(latlng));
	},

	mouseEventToContainerPoint: function (e) { // (MouseEvent)
		return L.DomEvent.getMousePosition(e, this._container);
	},

	mouseEventToLayerPoint: function (e) { // (MouseEvent)
		return this.containerPointToLayerPoint(this.mouseEventToContainerPoint(e));
	},

	mouseEventToLatLng: function (e) { // (MouseEvent)
		return this.layerPointToLatLng(this.mouseEventToLayerPoint(e));
	},


	// map initialization methods

	_initContainer: function (id) {
		var container = this._container = L.DomUtil.get(id);

		if (container._leaflet) {
			throw new Error("Map container is already initialized.");
		}

		container._leaflet = true;
	},

	_initLayout: function () {
		var container = this._container;

		container.innerHTML = '';
		container.className += ' leaflet-container';

		if (L.Browser.touch) {
			container.className += ' leaflet-touch';
		}

		if (this.options.fadeAnimation) {
			container.className += ' leaflet-fade-anim';
		}

		var position = L.DomUtil.getStyle(container, 'position');

		if (position !== 'absolute' && position !== 'relative' && position !== 'fixed') {
			container.style.position = 'relative';
		}

		this._initPanes();

		if (this._initControlPos) {
			this._initControlPos();
		}
	},

	_initPanes: function () {
		var panes = this._panes = {};

		this._mapPane = panes.mapPane = this._createPane('leaflet-map-pane', this._container);

		this._tilePane = panes.tilePane = this._createPane('leaflet-tile-pane', this._mapPane);
		this._objectsPane = panes.objectsPane = this._createPane('leaflet-objects-pane', this._mapPane);

		panes.shadowPane = this._createPane('leaflet-shadow-pane');
		panes.overlayPane = this._createPane('leaflet-overlay-pane');
		panes.markerPane = this._createPane('leaflet-marker-pane');
		panes.popupPane = this._createPane('leaflet-popup-pane');

		var zoomHide = ' leaflet-zoom-hide';

		if (!this.options.markerZoomAnimation) {
			panes.markerPane.className += zoomHide;
			panes.shadowPane.className += zoomHide;
			panes.popupPane.className += zoomHide;
		}
	},

	_createPane: function (className, container) {
		return L.DomUtil.create('div', className, container || this._objectsPane);
	},

	_initializers: [],

	_initHooks: function () {
		var i, len;
		for (i = 0, len = this._initializers.length; i < len; i++) {
			this._initializers[i].call(this);
		}
	},

	_initLayers: function (layers) {
		layers = layers ? (layers instanceof Array ? layers : [layers]) : [];

		this._layers = {};
		this._tileLayersNum = 0;

		var i, len;

		for (i = 0, len = layers.length; i < len; i++) {
			this.addLayer(layers[i]);
		}
	},


	// private methods that modify map state

	_resetView: function (center, zoom, preserveMapOffset, afterZoomAnim) {

		var zoomChanged = (this._zoom !== zoom);

		if (!afterZoomAnim) {
			this.fire('movestart');

			if (zoomChanged) {
				this.fire('zoomstart');
			}
		}

		this._zoom = zoom;

		this._initialTopLeftPoint = this._getNewTopLeftPoint(center);

		if (!preserveMapOffset) {
			L.DomUtil.setPosition(this._mapPane, new L.Point(0, 0));
		} else {
			this._initialTopLeftPoint._add(this._getMapPanePos());
		}

		this._tileLayersToLoad = this._tileLayersNum;

		this.fire('viewreset', {hard: !preserveMapOffset});

		this.fire('move');

		if (zoomChanged || afterZoomAnim) {
			this.fire('zoomend');
		}

		this.fire('moveend');

		if (!this._loaded) {
			this._loaded = true;
			this.fire('load');
		}
	},

	_rawPanBy: function (offset) {
		L.DomUtil.setPosition(this._mapPane, this._getMapPanePos().subtract(offset));
	},


	// map events

	_initEvents: function () {

		console.log("Init Events");

		if (!L.DomEvent) { return; }

		L.DomEvent.on(this._container, 'click', this._onMouseClick, this);

		var events = ['dblclick', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'contextmenu'];

		var i, len;

		for (i = 0, len = events.length; i < len; i++) {
			L.DomEvent.on(this._container, events[i], this._fireMouseEvent, this);
		}

		if (this.options.trackResize) {
			L.DomEvent.on(window, 'resize', this._onResize, this);
		}

		// Add a listener to handle webkitAnimationEnd failures
		L.DomEvent.on(this._container, "forceRefresh", this._onForceRefresh, this);
	},

	_onForceRefresh: function ()
	{
		// webkitAnimationEnd has failed - call a zoomIn() - magically fixes any issues we had.
		// Although it would be nice if this could happen without the entire zoomIn happening

		console.log("_onForceRefresh");

		setTimeout(L.Util.bind(function ()
		{
			this.zoomIn();
		}, this), 0);
	},

	_onResize: function () {
		// TODO cancel previous frame
		L.Util.requestAnimFrame(this.invalidateSize, this, false, this._container);
	},

	_onMouseClick: function (e) {
		if (!this._loaded || (this.dragging && this.dragging.moved())) { return; }
		
		this.fire('preclick');
		this._fireMouseEvent(e);
	},

	_fireMouseEvent: function (e) {
		if (!this._loaded) { return; }

		var type = e.type;

		type = (type === 'mouseenter' ? 'mouseover' : (type === 'mouseleave' ? 'mouseout' : type));

		if (!this.hasEventListeners(type)) { return; }

		if (type === 'contextmenu') {
			L.DomEvent.preventDefault(e);
		}

		var containerPoint = this.mouseEventToContainerPoint(e),
			layerPoint = this.containerPointToLayerPoint(containerPoint),
			latlng = this.layerPointToLatLng(layerPoint);

		this.fire(type, {
			latlng: latlng,
			layerPoint: layerPoint,
			containerPoint: containerPoint,
			originalEvent: e
		});
	},

	_onTileLayerLoad: function () {
		// TODO super-ugly, refactor!!!
		// clear scaled tiles after all new tiles are loaded (for performance)
		this._tileLayersToLoad--;
		if (this._tileLayersNum && !this._tileLayersToLoad && this._tileBg) {
			clearTimeout(this._clearTileBgTimer);
			this._clearTileBgTimer = setTimeout(L.Util.bind(this._clearTileBg, this), 500);
		}
	},


	// private methods for getting map state

	_getMapPanePos: function () {
		return L.DomUtil.getPosition(this._mapPane);
	},

	_getTopLeftPoint: function () {
		if (!this._loaded) {
			throw new Error('Set map center and zoom first.');
		}

		return this._initialTopLeftPoint.subtract(this._getMapPanePos());
	},

	_getNewTopLeftPoint: function (center, zoom) {
		var viewHalf = this.getSize().divideBy(2);
		// TODO round on display, not calculation to increase precision?
		return this.project(center, zoom)._subtract(viewHalf)._round();
	},

	_latLngToNewLayerPoint: function (latlng, newZoom, newCenter) {
		var topLeft = this._getNewTopLeftPoint(newCenter, newZoom).add(this._getMapPanePos());
		return this.project(latlng, newZoom)._subtract(topLeft)._round();
	},

	_getCenterLayerPoint: function () {
		return this.containerPointToLayerPoint(this.getSize().divideBy(2));
	},

	_getCenterOffset: function (center) {
		return this.latLngToLayerPoint(center).subtract(this._getCenterLayerPoint());
	},

	_limitZoom: function (zoom) {
		var min = this.getMinZoom(),
			max = this.getMaxZoom();

		return Math.max(min, Math.min(max, zoom));
	}
});

L.Map.addInitHook = function (fn) {
	var args = Array.prototype.slice.call(arguments, 1);

	var init = typeof fn === 'function' ? fn : function () {
		this[fn].apply(this, args);
	};

	this.prototype._initializers.push(init);
};