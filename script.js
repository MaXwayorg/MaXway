// --- Map Init ---
const makatiBounds = [[14.5000, 120.9800], [14.6000, 121.1000]];
const map = L.map('map', { maxBounds: makatiBounds, minZoom: 13 }).setView([14.5547, 121.0244], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

// Variables
let routingControl = null;
let startPoint = null;
let endPoint = null;
let startName = "Start Location";
let endName = "Destination";
let userMarker = null;
let isManualPinMode = false;
let watchID = null;
let currentRouteCoordinates = [];
let currentInstructions = [];
let currentTransport = null; 
let simulationInterval = null;

// --- CUSTOM MARKERS ---
// 1. Purple Circle for User/Start
const iconUser = L.divIcon({
    className: 'custom-div-icon',
    html: '<div class="gps-ring-marker"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
});

// 2. Red Pin for Destination
const iconEnd = L.icon({
    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/markers-default/red_2x.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});

// --- LOCATION & SEARCH ---
function locateUser() {
    if (!navigator.geolocation) return alert("GPS not supported");
    document.getElementById('start-input').placeholder = "Locating...";
    navigator.geolocation.getCurrentPosition((pos) => {
        setStartLocation(pos.coords.latitude, pos.coords.longitude, "📍 My Current Location");
    }, () => { alert("GPS Error."); });
}

function enableManualPin() {
    isManualPinMode = true;
    document.getElementById('manual-pin-msg').style.display = 'block';
    if(routingControl) map.removeControl(routingControl);
}

map.on('click', function(e) {
    if (isManualPinMode) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${e.latlng.lat}&lon=${e.latlng.lng}`)
            .then(res => res.json())
            .then(data => {
                const houseName = data.display_name.split(',')[0];
                setStartLocation(e.latlng.lat, e.latlng.lng, "📍 " + houseName);
            });
        isManualPinMode = false;
        document.getElementById('manual-pin-msg').style.display = 'none';
    }
});

function setStartLocation(lat, lng, label) {
    startPoint = L.latLng(lat, lng);
    startName = label;
    document.getElementById('start-input').value = label;
    
    // Update marker to Purple Circle
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([lat, lng], {icon: iconUser}).addTo(map);
    
    map.setView([lat, lng], 17);
    if (endPoint) calculateRoute();
}

async function searchDestination() {
    const query = document.getElementById('dest-input').value;
    if (!query) return alert("Please type a place name!");
    const searchQuery = query + " Makati Philippines";
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`;
    
    try {
        const response = await fetch(url);
        const results = await response.json();
        showResults(results);
    } catch (error) { alert("Network error"); }
}

function showResults(results) {
    const list = document.getElementById('results-list');
    list.innerHTML = "";
    list.style.display = 'block';
    if (results.length === 0) { list.innerHTML = "<li class='result-item'>No results.</li>"; return; }

    results.slice(0, 5).forEach(place => {
        const li = document.createElement('li');
        li.className = 'result-item';
        const parts = place.display_name.split(',');
        const shortName = parts[0] + (parts[1] ? "," + parts[1] : "");
        
        li.innerText = shortName;
        li.onclick = () => {
            endPoint = L.latLng(place.lat, place.lon);
            endName = shortName;
            document.getElementById('dest-input').value = shortName;
            document.getElementById('results-list').style.display = 'none';
            calculateRoute();
        };
        list.appendChild(li);
    });
}

// --- ROUTING ENGINE ---

function calculateRoute() {
    if (!startPoint || !endPoint) return;
    if (routingControl) map.removeControl(routingControl);

    routingControl = L.Routing.control({
        waypoints: [startPoint, endPoint],
        routeWhileDragging: false,
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
        // Use our custom markers
        createMarker: function(i, wp, nWps) {
            if (i === 0) return L.marker(wp.latLng, {icon: iconUser}); 
            if (i === nWps - 1) return L.marker(wp.latLng, {icon: iconEnd});
            return null;
        },
        lineOptions: { styles: [{color: 'white', opacity: 1, weight: 9}, {color: '#7c3aed', opacity: 1, weight: 6}] },
        show: false
    }).addTo(map);

    routingControl.on('routesfound', function(e) {
        const route = e.routes[0];
        currentRouteCoordinates = route.coordinates;
        currentInstructions = route.instructions;
        const summary = route.summary;
        const distKm = summary.totalDistance / 1000;
        
        currentTransport = predictTransport(startPoint, endPoint, distKm);

        // Time Calc
        let realisticTimeMin = 0;
        if (currentTransport.type === "walk") realisticTimeMin = (distKm / 4.5) * 60;
        else if (currentTransport.type === "trike") realisticTimeMin = (distKm / 15) * 60 + 5;
        else realisticTimeMin = (distKm / 12) * 60 + 10 + (currentTransport.rides > 1 ? 15 : 0);

        // Fare Calc
        let costDisplay = "₱ 0";
        if (currentTransport.type === "walk") costDisplay = "Free";
        else if (currentTransport.type === "trike") costDisplay = "₱ 20";
        else {
            const numRides = currentTransport.rides || 1;
            const fare = (13 * numRides) + (distKm > 4 ? (distKm - 4) * 2 : 0);
            costDisplay = "₱ " + Math.round(fare);
        }
        
        document.getElementById('route-card').style.display = 'block';
        document.getElementById('time-val').innerText = Math.round(realisticTimeMin) + " min";
        document.getElementById('cost-val').innerText = costDisplay;
        document.getElementById('trans-icon').innerText = currentTransport.icon;
        document.getElementById('trans-name').innerText = currentTransport.name;
    });
}

function predictTransport(start, end, distKm) {
    // 1. Walking
    if (distKm < 0.5) return { type: "walk", rides: 0, icon: "🚶", name: "Walking Distance" };
    
    // 2. Tricycle (Short + Non-CBD)
    const isCBD = (start.lat > 14.545 && start.lat < 14.562 && start.lng > 121.015 && start.lng < 121.035);
    if (distKm >= 0.5 && distKm < 1.5 && !isCBD) return { type: "trike", rides: 1, icon: "🛺", name: "Tricycle (Local)" };
    
    // 3. Complex Trip (2 Rides)
    if (distKm > 2.5) return { type: "jeep", rides: 2, icon: "🔄", name: "2 Rides Needed" };

    // 4. Simple Route Logic
    const lat = end.lat; const lng = end.lng;
    if (Math.abs(lat - 14.5615) < 0.0035) return { type: "jeep", rides: 1, icon: "🚙", name: "Jeep: Guadalupe" };
    if (lng > 121.0100 && lng < 121.0180) return { type: "jeep", rides: 1, icon: "🚙", name: "Jeep: PRC - Mantrade" };
    if (lat > 14.5640) return { type: "jeep", rides: 1, icon: "🚙", name: "Jeep: Leon Guinto" };
    if (lat > 14.5500 && lat < 14.5600 && lng > 121.0200) return { type: "jeep", rides: 1, icon: "🚙", name: "Jeep: Ayala Loop" };
    return { type: "jeep", rides: 1, icon: "🚙", name: "Jeep: Makati Loop" };
}

// --- NAV MODE & TEXT GENERATION ---

function enterNavMode() {
    document.getElementById('search-ui').style.display = 'none';
    document.getElementById('nav-ui').style.display = 'block';
    document.getElementById('nav-start-addr').innerText = startName;
    document.getElementById('nav-end-addr').innerText = endName;
    generateTextDirections();
    
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker(startPoint, {icon: iconUser, zIndexOffset: 1000}).addTo(map);
    map.flyTo(startPoint, 18, { animate: true, duration: 1.5 });
}

// HELPER: Get Smart Terminal Name
function getTerminalName(jeepName) {
    if(jeepName.includes("Guadalupe")) return "Walk to Guadalupe Market Terminal";
    if(jeepName.includes("PRC")) return "Walk to Circuit/PRC Terminal";
    if(jeepName.includes("Ayala")) return "Walk to Ayala Triangle Loading Zone";
    if(jeepName.includes("Leon Guinto")) return "Walk to JP Rizal Loading Bay";
    if(jeepName.includes("Loop")) return "Walk to Landmark Jeep Terminal";
    return "Walk to Main Road Loading Zone";
}

function generateTextDirections() {
    const list = document.getElementById('directions-list');
    list.innerHTML = "";
    const costText = document.getElementById('cost-val').innerText;

    addWalkStep(list, `Start at ${startName}`, "Head towards the road");

    if (currentTransport.type === "jeep" && currentTransport.rides === 2) {
        // --- 2 RIDES ---
        // Terminal for first ride (generic logic for complex trip)
        addWalkStep(list, "Walk to Nearest Jeepney Stop", "Boarding Area"); 
        addRideStep(list, "RIDE 1: First Jeepney", "₱ 13.00", "purple", "🚙");
        
        // Transfer Step
        const transferLi = document.createElement('li');
        transferLi.className = 'step-item step-transfer';
        transferLi.innerHTML = `<div class="step-icon">🔄</div><div class="step-details"><div class="step-content">TRANSFER</div><span class="step-meta">Alight and wait for next jeep</span></div>`;
        list.appendChild(transferLi);

        addRideStep(list, "RIDE 2: Second Jeepney", "₱ 13.00 (+ dist)", "purple", "🚙");
        addWalkStep(list, "Alight at Destination Vicinity", "Check driver for stop");

    } else if (currentTransport.type !== "walk") {
        // --- SINGLE RIDE ---
        let pickupText = "Walk to Pickup Point";
        if(currentTransport.type === "jeep") {
            pickupText = getTerminalName(currentTransport.name);
        } else {
            pickupText = "Walk to Tricycle TODA/Corner";
        }

        addWalkStep(list, pickupText, "Boarding Area");
        
        const color = currentTransport.type === 'trike' ? 'orange' : 'purple';
        addRideStep(list, `RIDE: ${currentTransport.name}`, `Total: ${costText}`, color, currentTransport.icon);
        addWalkStep(list, "Alight at Destination Vicinity", "Check driver for stop");
    }

    // Last Mile
    currentInstructions.slice(-2).forEach((step) => {
        if (step.distance > 20) addWalkStep(list, `Walk along ${step.road || "road"}`, `${Math.round(step.distance)} meters`);
    });

    // End Step
    const lastLi = document.createElement('li');
    lastLi.className = 'step-item step-walk';
    lastLi.innerHTML = `<div class="step-icon">📍</div><div class="step-details"><div class="step-content">Arrive at ${endName}</div><span class="step-meta">Destination reached</span></div>`;
    list.appendChild(lastLi);
}

function addWalkStep(list, mainText, subText) {
    const li = document.createElement('li');
    li.className = 'step-item step-walk';
    li.innerHTML = `<div class="step-icon">🚶</div><div class="step-details"><div class="step-content">${mainText}</div><span class="step-meta">${subText}</span></div>`;
    list.appendChild(li);
}

function addRideStep(list, mainText, costInfo, colorType, icon) {
    const li = document.createElement('li');
    li.className = 'step-item step-ride';
    const color = colorType === 'orange' ? '#f59e0b' : '#7c3aed';
    const bg = colorType === 'orange' ? '#fffbeb' : '#fdf4ff';
    li.style.borderLeftColor = color; li.style.background = bg;
    li.innerHTML = `<div class="step-icon" style="color:${color}">${icon}</div><div class="step-details"><div class="step-content" style="color:${color}">${mainText}</div><span class="step-meta">Prepare payment: <strong>${costInfo}</strong></span></div>`;
    list.appendChild(li);
}

// --- SIMULATION & FEEDBACK ---

function startRealTimeNavigation() {
    if (!startPoint || !endPoint) return;
    enterNavMode();
    if (navigator.geolocation) {
        watchID = navigator.geolocation.watchPosition((pos) => {
            const newLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
            userMarker.setLatLng(newLatLng);
            map.panTo(newLatLng);
        }, null, { enableHighAccuracy: true });
    }
}

function startSimulation() {
    if (!currentRouteCoordinates || currentRouteCoordinates.length === 0) return;
    enterNavMode();
    let index = 0;
    simulationInterval = setInterval(() => {
        if (index >= currentRouteCoordinates.length) { stopNavigation(); return; }
        const coord = currentRouteCoordinates[index];
        const newLatLng = L.latLng(coord.lat, coord.lng);
        userMarker.setLatLng(newLatLng);
        map.panTo(newLatLng);
        index++;
    }, 50);
}

// STOP -> Open Modal
function stopNavigation() {
    if (watchID) navigator.geolocation.clearWatch(watchID);
    if (simulationInterval) clearInterval(simulationInterval);
    
    // Open Feedback Modal
    document.getElementById('feedback-modal').style.display = 'flex';
}

// SUBMIT -> Reset UI
function submitFeedback() {
    document.getElementById('feedback-modal').style.display = 'none';
    document.getElementById('nav-ui').style.display = 'none';
    document.getElementById('search-ui').style.display = 'block';
    
    // Reset View
    map.flyTo(startPoint, 16, { animate: true, duration: 1 });
    
    // Reset text
    document.getElementById('feedback-text').value = "";
}


