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
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; 
let ignoreTemporaryState = false; 
let lastSyncState = null; 

// --- USER IDENTIFICATION ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Partner's Name):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}
const partnerName = (myName === "Sarthak" || myName === "sarthak") ? "Partner" : "Sarthak";


// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER FUNCTIONS (API Required) ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 0,             // HIDES NATIVE PLAYER CONTROLS (Play/Pause, Seek Bar)
            'disablekb': 0, 
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
    // Volume Control Removed: Initialize default volume and skip UI listeners.
    if (player && player.setVolume) {
        player.setVolume(70); // Keep default volume set, even without UI bar
    }
    
    // Time broadcast interval (for sync)
    setInterval(broadcastTimeIfPlaying, 1000); 

    // On-Disconnect Cleanup (Keep commented out unless explicitly needed)
    // queueRef.onDisconnect().remove();
    // syncRef.onDisconnect().remove();
    
    loadInitialData(); 
}

function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Auto play next song if ended 
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        // Only broadcast state if we are the last known broadcaster and currently playing
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
            broadcastState('play', currentTime, currentVideoId, false);
        }
    }
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
                // Local player paused on its own (ad/buffer)
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

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    
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
    isManualAction = true; 
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        isManualAction = false; 
        ignoreTemporaryState = true; 
        
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        // Broadcast after a slight delay to confirm player state is PLAYING/BUFFERING
        setTimeout(() => {
            if(player.getPlayerState() === YT.PlayerState.PLAYING || player.getPlayerState() === YT.PlayerState.BUFFERING) {
                 broadcastState('play', player.getCurrentTime(), videoId, false); 
            }
        }, 300); 
        
        renderQueue(currentQueue, currentVideoId);
    }
}


// ------------------------------------------------------------------------------------------------------
// --- QUEUE MANAGEMENT ---
// ------------------------------------------------------------------------------------------------------

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    // Loop back to start if at the end, or move to the next index
    const nextIndex = (currentIndex + 1) % currentQueue.length; 
    
    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[nextIndex].videoId, currentQueue[nextIndex].title);
    } else {
        currentVideoId = null;
        if (player && player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    // Loop back to end if at the start
    if (prevIndex < 0) { prevIndex = currentQueue.length - 1; } 
    
    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[prevIndex].videoId, currentQueue[prevIndex].title);
    }
}

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
            if (!currentVideoId && currentQueue.length === 0 && songs.length > 0) {
                // If the queue was empty and we added songs, load the first one
                setTimeout(() => {
                    const firstSong = songs[0];
                    if (firstSong) { loadAndPlayVideo(firstSong.videoId, firstSong.title); }
                }, 500);
            }
        })
        .catch(error => { console.error("Error adding batch to queue:", error); });
}

function removeFromQueue(videoId, event) {
    if (event) event.stopPropagation();
    const songToRemove = currentQueue.find(song => song.videoId === videoId); 
    
    if (songToRemove && songToRemove.key) {
        queueRef.child(songToRemove.key).remove()
            .then(() => {
                if (videoId === currentVideoId) { playNextSong(); }
            })
            .catch(error => { console.error("Error removing song:", error); });
    }
}

// ------------------------------------------------------------------------------------------------------
// --- RENDERING VIEWS ---
// ------------------------------------------------------------------------------------------------------

// ... (renderQueue and renderSearchResults functions remain the same) ...
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
        // Note: The thumbnail URL must be URI-encoded for safe use in JS string arguments
        const safeThumbnail = encodeURIComponent(song.thumbnail);
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', decodeURIComponent('${safeThumbnail}'), event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultsList.appendChild(item);
    });
}
// ------------------------------------------------------------------------------------------------------


// ------------------------------------------------------------------------------------------------------
// --- SEARCH & LINK HANDLERS (IMPROVED) ---
// ------------------------------------------------------------------------------------------------------

async function searchYouTube(query, maxResults = 10, type = 'video') {
    // IMPORTANT: Added `part=snippet` and `type=video` for reliability
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
                thumbnail: item.snippet.thumbnails.default.url // Use default for better load time
            }));
        
        return results;

    } catch (error) {
        console.error("YouTube Search Fetch Error:", error);
        return [];
    }
}

function extractPlaylistId(url) {
    // Covers standard and shortened YouTube Music links for playlists
    const regex = /(?:list=)([a-zA-Z0-9_-]+)/;
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
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error fetching playlist: ${data.error.message}. Check the link or your API key.</p>`;
            return;
        }

        const newSongs = data.items
            .filter(item => item.snippet && item.snippet.resourceId && item.snippet.resourceId.kind === 'youtube#video')
            .map(item => ({
                videoId: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        allSongs = allSongs.concat(newSongs);

        if (data.nextPageToken) {
            // Recursive call for next page
            return await fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        } else {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Found ${allSongs.length} songs from the playlist. Adding to queue...</p>`;
            addBatchToQueue(allSongs);
            setTimeout(() => switchTab('queue'), 3000); 
        }

    } catch (error) {
        console.error("Playlist Fetch Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Failed to fetch playlist items. Network error or invalid ID.</p>';
    }
}

function extractSpotifyId(url) {
    // Extracts ID from track, album, or playlist links
    const match = url.match(/(?:playlist|album|track)\/([a-zA-Z0-9]+)/);
    if (match) {
        return url; // Return the full URL for the proxy
    }
    return null;
}

async function fetchSpotifyData(link) {
    const statusDiv = document.getElementById('results-list');
    statusDiv.innerHTML = '<p class="empty-state">Attempting to fetch Spotify data and find YouTube matches (This may take a moment)...</p>';

    // NOTE: This relies on a separate proxy server for Spotify API access. 
    const proxyUrl = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;

    try {
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (!data || data.error || !data.tracks || data.tracks.length === 0) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Failed to fetch Spotify data or playlist is empty. (Error: ${data.error || 'Unknown'})</p>`;
            return;
        }
        
        const tracksToSearch = data.tracks.slice(0, 50); // Limit to 50 to prevent huge request load
        const foundSongs = [];
        
        statusDiv.innerHTML = `<p class="empty-state">Found ${tracksToSearch.length} tracks. Searching YouTube for matches...</p>`;

        for (const track of tracksToSearch) {
            const query = `${track.artist} - ${track.title}`;
            const results = await searchYouTube(query, 1); 
            
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

async function handleSearchAndLinks() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    // 1. Check for YouTube Playlist Link (including YouTube Music)
    const playlistId = extractPlaylistId(query);
    if (playlistId) {
        await fetchPlaylist(playlistId);
        inputElement.value = ''; 
        return;
    }
    
    // 2. Check for Spotify Link (Track, Album, or Playlist)
    const spotifyLink = extractSpotifyId(query);
    if (spotifyLink) {
        await fetchSpotifyData(spotifyLink); 
        inputElement.value = '';
        return;
    }

    // 3. Perform Standard YouTube Search
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p class="empty-state">Searching...</p>';

    currentSearchResults = await searchYouTube(query, 10);
    
    if (currentSearchResults.length === 0) {
        document.getElementById('results-list').innerHTML = '<p class="empty-state" style="color: var(--text-error);">Search failed! Check your API key, network, or try a simpler query.</p>';
    } else {
        renderSearchResults(currentSearchResults);
    }
    
    inputElement.value = '';
}


// ------------------------------------------------------------------------------------------------------
// --- FIREBASE SYNC (REALTIME DATABASE) ---
// ------------------------------------------------------------------------------------------------------

// ... (loadInitialData, broadcastState, applyRemoteCommand, forcePlay, updateSyncStatus remain the same) ...

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
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 
    
    const localTime = player.getCurrentTime ? player.getCurrentTime() : 0; 
    
    // CRITICAL AD STALL LOGIC ENFORCEMENT
    if (!partnerIsPlaying && state.isAdStall) {
         document.getElementById('syncOverlay').classList.add('active');
         if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
         }
         return; 
    }
    
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
        // TIME CORRECTION
        const timeDiff = Math.abs(localTime - state.time);
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

function forcePlay() {
    document.getElementById('syncOverlay').classList.remove('active');
    if (currentVideoId) {
        player.playVideo();
        broadcastState('play', player.getCurrentTime(), currentVideoId, false);
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

// ------------------------------------------------------------------------------------------------------
// --- CHAT FUNCTIONS ---
// ------------------------------------------------------------------------------------------------------

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


// ------------------------------------------------------------------------------------------------------
// --- INITIALIZATION: EVENT LISTENERS ---
// ------------------------------------------------------------------------------------------------------

function initializeAppListeners() {
    console.log("Setting up application event listeners (Cleaned)...");
    
    // 1. Player Controls
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('prev-btn').addEventListener('click', playPreviousSong);
    document.getElementById('next-btn').addEventListener('click', playNextSong);

    // 2. Search Handlers 
    document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            handleSearchAndLinks();
        }
    });
    
    // 3. Tab Switches (Using delegated listeners)
    document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
    document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));


    // 4. Chat Handlers
    document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault(); 
            sendChatMessage();
        }
    });

    // 5. Sync Overlay Control
    document.getElementById('forceSyncBtn').addEventListener('click', forcePlay);
    
    // 6. Initial Tab Load
    switchTab('queue');
}

// Execute the listener setup when the script loads
initializeAppListeners();
