// ================= CONFIGURATION =================
// 1. YOUR FIREBASE CONFIG
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};

// 2. YOUR YOUTUBE DATA API KEY
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
    listenForSync(); 
}

// ================= SEARCH FUNCTIONALITY =================

function handleEnter(e) {
    if(e.key === 'Enter') searchYouTube();
}

async function searchYouTube() {
    const query = document.getElementById('searchInput').value;
    if (!query) return;

    // Fetch call using the YouTube API key
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
        card.onclick = () => selectSong(videoId, title); // Passes title for debug

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

// Added songTitle parameter for easy debugging
function selectSong(videoId, songTitle) { 
    console.log(`Attempting to set song in Firebase: ${songTitle} (${videoId})`); // <-- DEBUGGING LINE
    
    // Send the new video ID to Firebase
    syncRef.update({
        videoId: videoId,
        status: 'play',
        timestamp: Date.now()
    }).then(() => {
        console.log("Firebase update succeeded.");
        document.getElementById('statusText').innerText = `Loading: ${songTitle.substring(0, 30)}...`;
    }).catch(error => {
        console.error("Firebase update failed:", error); // <-- CRITICAL DEBUG
        alert("Sync failed! Check your Firebase Rules/Internet connection.");
    });
}

function syncAction(action) {
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
            document.getElementById('statusText').innerText = "Playing for Sarthak & Reechita...";
        } else if (data.status === 'pause') {
            player.pauseVideo();
            document.getElementById('statusText').innerText = "Paused.";
        }
    });
}
