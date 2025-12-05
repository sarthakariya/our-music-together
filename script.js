// --- CONFIGURATION ---
// Your Firebase Configuration (Provided by Sarthak)
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
// Your YouTube API Key (Provided by Sarthak)
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();
const syncRef = db.ref('sync');
const queueRef = db.ref('queue');
const chatRef = db.ref('chat');

// --- GLOBAL STATE ---
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isSeeking = false;
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; 
let ignoreTemporaryState = false; 
let lastSyncState = null; 
// ----------------------------

// --- USER IDENTIFICATION ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Reechita):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}
const partnerName = (myName === "Sarthak") ? "Reechita" : "Sarthak";
// ----------------------------


// --- YOUTUBE PLAYER FUNCTIONS ---

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 0, 
            'disablekb': 1,
            'rel': 0,
            'showinfo': 0,
            'modestbranding': 1,
            'autoplay': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    player.setVolume(70); 
    document.getElementById('volume-progress').style.width = '70%'; 
    
    // Attach listeners
    document.getElementById('volume-bar').addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        player.setVolume(volume);
        document.getElementById('volume-progress').style.width = volume + '%';
    });

    const seekBar = document.getElementById('seek-bar');
    seekBar.addEventListener('mousedown', () => { isSeeking = true; });
    seekBar.addEventListener('mouseup', (e) => {
        isSeeking = false;
        const newTime = (player.getDuration() * e.target.value) / 100;
        player.seekTo(newTime, true);
        broadcastState('seek', newTime, currentVideoId, false); 
    });
    seekBar.addEventListener('input', (e) => {
        const newTime = (player.getDuration() * e.target.value) / 100;
        updateTimeDisplay(newTime, player.getDuration());
    });
    
    setInterval(updateLocalTime, 1000);

    loadInitialData(); 
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = pauseIcon;
        isManualAction = false; 
        ignoreTemporaryState = false; 
        
    } else {
        playPauseBtn.innerHTML = playIcon;

        // CRITICAL AD/BUFFER LOGIC
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            
            if (!isPartnerPlaying && !isManualAction && !ignoreTemporaryState) {
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, true); 
            }
        } 
        
        if (event.data === YT.PlayerState.ENDED) {
            if (!isPartnerPlaying) {
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
            }
            playNextSong();
        }
    }
    
    isManualAction = false;
    isPartnerPlaying = false; 
    
    if (ignoreTemporaryState) {
        setTimeout(() => { ignoreTemporaryState = false; }, 500); 
    }
    
    updateSyncStatus();
}

function updateLocalTime() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        if (!isSeeking) {
            updateTimeDisplay(currentTime, duration);
            const seekPercentage = (currentTime / duration) * 100;
            document.getElementById('seek-bar').value = seekPercentage;
            document.getElementById('seek-progress').style.width = seekPercentage + '%';
        }
        
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
             broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    
    isManualAction = true; 
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        document.getElementById('syncOverlay').classList.remove('active'); 
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            document.getElementById('syncOverlay').classList.remove('active');
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        isManualAction = false; 
        ignoreTemporaryState = true; 
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        broadcastState('play', player.getCurrentTime(), videoId, false); 
        
        updateTimeDisplay(0, player.getDuration());
        renderQueue(currentQueue, currentVideoId);
    }
}

function updateTimeDisplay(currentTime, duration) {
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        const pad = (num) => num.toString().padStart(2, '0');
        
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    };
    
    document.getElementById('current-time').textContent = formatTime(currentTime);
    document.getElementById('duration').textContent = formatTime(duration);
}

// --- QUEUE MANAGEMENT (Unchanged for brevity) ---
function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length;
    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[nextIndex].videoId, currentQueue[nextIndex].title);
    } else {
        currentVideoId = null;
        if (player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) { prevIndex = currentQueue.length - 1; }
    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[prevIndex].videoId, currentQueue[prevIndex].title);
    }
}

document.getElementById('prev-btn').onclick = playPreviousSong;
document.getElementById('next-btn').onclick = playNextSong;

function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    const newSong = { videoId, title, uploader, thumbnail };
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set(newSong)
        .then(() => { switchTab('queue'); })
        .catch(error => { console.error("Error adding song to queue:", error); });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;
    const updates = {};
    songs.forEach(song => {
        const newKey = queueRef.push().key;
        updates[newKey] = song;
    });
    queueRef.update(updates)
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && songs.length > 0) {
                setTimeout(() => {
                    if (currentQueue.length > 0) {
                         const firstSong = currentQueue.find(s => s.videoId === songs[0].videoId);
                         if (firstSong) { loadAndPlayVideo(firstSong.videoId, firstSong.title); }
                    }
                }, 500);
            }
        })
        .catch(error => { console.error("Error adding batch to queue:", error); });
}

function removeFromQueue(videoId, event) {
    if (event) event.stopPropagation();
    const songToRemove = currentQueue.find(song => song.videoId === currentVideoId);
    if (songToRemove && songToRemove.key) {
        queueRef.child(songToRemove.key).remove()
            .then(() => {
                if (videoId === currentVideoId) { playNextSong(); }
            })
            .catch(error => { console.error("Error removing song:", error); });
    }
}

function clearQueue() {
    if (confirm("Are you sure you want to clear the entire queue?")) {
        queueRef.remove()
            .then(() => {
                currentVideoId = null;
                if (player.stopVideo) player.stopVideo();
                document.getElementById('current-song-title').textContent = "Queue Cleared";
            })
            .catch(error => { console.error("Error clearing queue:", error); });
    }
}

// --- RENDERING VIEWS (Unchanged for brevity) ---
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(list => list.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    document.getElementById(`${tabName}-list`).classList.add('active');
}

function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        document.getElementById('queue-count').textContent = 0;
        document.getElementById('total-queue-size').textContent = 0;
        return;
    }
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.setAttribute('onclick', `loadAndPlayVideo('${song.videoId}', '${song.title.replace(/'/g, "\\'")}')`);
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="del-btn" title="Remove from Queue" onclick="removeFromQueue('${song.videoId}', event)">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;
        queueList.appendChild(item);
    });
    document.getElementById('queue-count').textContent = queueArray.length;
    document.getElementById('total-queue-size').textContent = queueArray.length;
    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = ''; 
    if (resultsArray.length === 0) {
        resultsList.innerHTML = '<p class="empty-state">No search results found. Try a different query!</p>';
        return;
    }
    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', '${song.thumbnail}', event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultsList.appendChild(item);
    });
}


// --- YOUTUBE SEARCH & PLAYLIST PARSING (Updated) ---

async function searchYouTube(query, maxResults = 10, type = 'video') {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${type}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
             console.error("YouTube API Error:", data.error.message);
             return [];
        }

        const results = data.items
            .filter(item => item.id.kind === 'youtube#video')
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        return results;

    } catch (error) {
        console.error("YouTube Search Fetch Error:", error);
        return [];
    }
}

function extractPlaylistId(url) {
    const regex = /[?&]list=([^&]+)/;
    const match = url.match(regex);
    if (match) {
        return match[1];
    }
    return null;
}

async function fetchPlaylist(playlistId, pageToken = null, allSongs = []) {
    switchTab('results');
    const statusDiv = document.getElementById('results-list');
    
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    
    try {
        statusDiv.innerHTML = `<p class="empty-state">Fetching playlist (Total songs: ${allSongs.length})... Please wait.</p>`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error fetching playlist: ${data.error.message}</p>`;
            return;
        }

        const newSongs = data.items
            .filter(item => item.snippet.resourceId.kind === 'youtube#video')
            .map(item => ({
                videoId: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        allSongs = allSongs.concat(newSongs);

        if (data.nextPageToken) {
            return await fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        } else {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Found ${allSongs.length} songs from the playlist. Adding to queue...</p>`;
            addBatchToQueue(allSongs);
            setTimeout(() => switchTab('queue'), 3000); 
        }

    } catch (error) {
        console.error("Playlist Fetch Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Failed to fetch playlist items. Check API Key/Network.</p>';
    }
}

// --- NEW SPOTIFY WORKAROUND ---

function extractSpotifyId(url) {
    const match = url.match(/(?:playlist|album|track)\/([a-zA-Z0-9]+)/);
    if (match) {
        return match[1];
    }
    return null;
}

async function fetchSpotifyData(link) {
    // Note: Spotify API requires a backend server for OAuth. 
    // We will use a public proxy/API to fetch playlist/album metadata.
    // WARNING: These proxies can break or be unreliable.
    
    const statusDiv = document.getElementById('results-list');
    statusDiv.innerHTML = '<p class="empty-state">Attempting to fetch Spotify data (This may take a moment)...</p>';

    // This is a common public proxy endpoint structure for demonstration
    // If this specific endpoint breaks, a different one must be used.
    const proxyUrl = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;

    try {
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (!data || data.error || !data.tracks || data.tracks.length === 0) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Failed to fetch Spotify data or playlist is empty. (Error: ${data.error || 'Unknown'})</p>`;
            return;
        }
        
        // Use the first 50 songs to prevent API overload
        const tracksToSearch = data.tracks.slice(0, 50); 
        const foundSongs = [];
        
        statusDiv.innerHTML = `<p class="empty-state">Found ${tracksToSearch.length} tracks. Searching YouTube for matches...</p>`;

        for (const track of tracksToSearch) {
            // Search YouTube for "Artist - Track Name"
            const query = `${track.artist} - ${track.title}`;
            const results = await searchYouTube(query, 1); // Get only the top result
            
            if (results.length > 0) {
                foundSongs.push(results[0]);
            }
            statusDiv.innerHTML = `<p class="empty-state">Searching YouTube... Found ${foundSongs.length} matches out of ${tracksToSearch.length} tracks.</p>`;
        }
        
        if (foundSongs.length > 0) {
             statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Added ${foundSongs.length} songs from Spotify link to the queue!</p>`;
             addBatchToQueue(foundSongs);
        } else {
             statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Could not find matching YouTube videos for the Spotify tracks.</p>`;
        }
        setTimeout(() => switchTab('queue'), 3000); 
        
    } catch (error) {
        console.error("Spotify Proxy Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Connection error while fetching Spotify data. The proxy may be down.</p>';
    }
}


// --- MAIN SEARCH HANDLER (Updated to handle links/keywords) ---

async function handleSearchAndLinks() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    // 1. Check for YouTube Playlist Link
    const playlistId = extractPlaylistId(query);
    if (playlistId) {
        await fetchPlaylist(playlistId);
        inputElement.value = ''; 
        return;
    }
    
    // 2. Check for Spotify Link
    const spotifyId = extractSpotifyId(query);
    if (spotifyId) {
        await fetchSpotifyData(query); 
        inputElement.value = '';
        return;
    }

    // 3. Perform Standard YouTube Search
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p class="empty-state">Searching...</p>';

    currentSearchResults = await searchYouTube(query, 10);
    
    renderSearchResults(currentSearchResults);
    inputElement.value = '';
}

document.getElementById('search-btn').onclick = handleSearchAndLinks;
document.getElementById('searchInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        handleSearchAndLinks();
    }
});


// --- FIREBASE SYNC (REALTIME DATABASE) (Unchanged for brevity) ---

function loadInitialData() {
    // 1. Queue Listener
    queueRef.on('value', (snapshot) => {
        const queueData = snapshot.val();
        currentQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                currentQueue.push({ ...queueData[key], key: key });
            });
        }
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync Command Listener
    syncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        lastSyncState = syncState; 

        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 

            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        } else {
             document.getElementById('syncOverlay').classList.remove('active');
        }
        
        if (document.getElementById('syncOverlay').classList.contains('active')) {
             document.getElementById('overlayTitle').textContent = `Awaiting ${lastBroadcaster} to resume...`;
             document.getElementById('overlayText').innerHTML = `Playback paused due to a **${lastBroadcaster}** Ad/Buffer stall. You cannot resume playback until they do.`;
        }
        
        updateSyncStatus();
    });

    // 3. Chat Listener
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;

    syncRef.set({
        action: action, 
        time: time,
        videoId: videoId,
        lastUpdater: myName, 
        isAdStall: isAdStall, 
        timestamp: Date.now()
    }).catch(error => {
        console.error("Error broadcasting state:", error);
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 

    // CRITICAL AD STALL LOGIC ENFORCEMENT
    if (!partnerIsPlaying && state.isAdStall) {
         document.getElementById('syncOverlay').classList.add('active');
         if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
         }
         return; 
    }
    // END CRITICAL AD STALL LOGIC ENFORCEMENT


    if (state.videoId !== currentVideoId) {
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        renderQueue(currentQueue, currentVideoId);
        
    } else if (state.action === 'seek') {
        player.seekTo(state.time, true);

    } else {
        const timeDiff = Math.abs(player.getCurrentTime() - state.time);
        if (timeDiff > 2) {
            player.seekTo(state.time, true);
        }
    }
    
    // Play/Pause Command Logic (Non-Ad-Stall)
    if (partnerIsPlaying) {
        document.getElementById('syncOverlay').classList.remove('active');
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } else {
        document.getElementById('syncOverlay').classList.remove('active');
        
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    
    if (document.getElementById('syncOverlay').classList.contains('active')) {
         msgEl.innerHTML = `<i class="fa-solid fa-sync fa-spin"></i> **AWAITING PARTNER** (Halted by ${lastBroadcaster})`;
         msgEl.style.color = 'var(--accent)';
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> **DEEP SYNC ACTIVE**`;
        msgEl.style.color = 'var(--primary)';
    } else {
        if (lastSyncState && lastSyncState.action === 'pause' && lastSyncState.isAdStall === true) {
            msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> **WARNING: STALE AD STALL** (Last by ${lastBroadcaster})`;
            msgEl.style.color = 'var(--text-error)';
        } else {
            msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> **PAUSED**`;
            msgEl.style.color = 'var(--text-dim)';
        }
    }
}


// --- CHAT FUNCTIONS (Unchanged for brevity) ---

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    chatRef.push({
        user: myName,
        text: text,
        timestamp: Date.now()
    }).then(() => {
        input.value = ''; 
    }).catch(error => {
        console.error("Error sending message:", error);
    });
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const isMe = user === myName;
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    msgDiv.innerHTML = `
        <strong>${user}:</strong> ${safeText}
        <small>${time}</small>
    `;
    
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chatInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});
