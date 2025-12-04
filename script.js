// ================= CONFIGURATION =================
// 1. YOUR FIREBASE CONFIG: Paste the ENTIRE object from Phase I, Step 2
const firebaseConfig = {
    apiKey: "PASTE_FIREBASE_API_KEY", 
    authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
    databaseURL: "PASTE_DATABASE_URL",
    projectId: "PASTE_PROJECT_ID",
    appId: "NUMBERS"
};

// 2. YOUR YOUTUBE DATA API KEY (From Phase I, Step 3)
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const syncRef = database.ref('currentSession');

// ================= YOUTUBE PLAYER SETUP =================
var player;
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: 'M7lc1UVf-VE', 
        playerVars: { 'playsinline': 1, 'controls': 0, 'rel': 0 },
        events: { 'onReady': onPlayerReady }
    });
}

// Load YouTube API
var tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
var firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function onPlayerReady(event) {
    listenForSync(); // Start listening to Firebase
}

// ================= SEARCH FUNCTIONALITY =================

function handleEnter(e) {
    if(e.key === 'Enter') searchYouTube();
}

async function searchYouTube() {
    const query = document.getElementById('searchInput').value;
    if (!query) return;

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${query}&type=video&key=${YOUTUBE_API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        displayResults(data.items);
    } catch (error) {
        console.error("Error searching:", error);
        document.getElementById('results-container').innerHTML = `<p style="color: #ff4d4d;">Search failed. Check your API key or quota!</p>`;
    }
}

function displayResults(videos) {
    const container = document.getElementById('results-container');
    container.innerHTML = ""; 

    videos.forEach(video => {
        const title = video.snippet.title;
        const thumbnail = video.snippet.thumbnails.default.url;
        const videoId = video.id.videoId;

        const card = document.createElement('div');
        card.className = 'song-card';
        card.onclick = () => selectSong(videoId); 

        card.innerHTML = `
            <img src="${thumbnail}" alt="thumb">
            <div class="song-info">
                <h4>${title}</h4>
            </div>
        `;

        container.appendChild(card);
    });
}

// ================= SYNCING LOGIC =================

function selectSong(videoId) {
    // Send the new video ID to Firebase
    syncRef.update({
        videoId: videoId,
        status: 'play',
        timestamp: Date.now()
    });
}

function syncAction(action) {
    // Send the action (play/pause) to Firebase
    syncRef.update({
        status: action,
        timestamp: Date.now()
    });
}

function listenForSync() {
    syncRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        // Sync Video
        if (player.getVideoData().video_id !== data.videoId && data.videoId) {
            player.loadVideoById(data.videoId);
        }

        // Sync Play/Pause
        if (data.status === 'play') {
            player.playVideo();
            document.getElementById('statusText').innerText = "Playing for you & her...";
        } else if (data.status === 'pause') {
            player.pauseVideo();
            document.getElementById('statusText').innerText = "Paused.";
        }
    });
}
