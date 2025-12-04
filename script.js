// ================= CONFIGURATION & VARIABLES =================
// (Keep existing configuration and dom variables)
// ...

// New Firebase Structure to monitor individual Heartbeats
const playerRef = database.ref('playerStatus/' + new Date().getTime()); // Unique reference for this device
let lastReportedTime = 0;

// ================= YOUTUBE SETUP =================
// (Keep existing onYouTubeIframeAPIReady and onPlayerReady)
// ...
function onPlayerReady() {
    listenForSync();
    // Start monitoring: 500ms for UI, 1000ms for Heartbeat
    setInterval(updateProgress, 500);
    setInterval(sendHeartbeat, 1000); // 1-second pulse
}

// ================= AD & SYNC LOGIC (HEARTBEAT FIX) =================

function sendHeartbeat() {
    if (!player || queue.length === 0 || player.getPlayerState() !== 1) return; // Only send heartbeats when playing

    const currentTime = player.getCurrentTime();
    
    // Report my status and current time
    playerRef.update({
        time: currentTime,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        isSeeking: isDragging,
        queueIndex: queueIndex
    });
}

function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        
        // HEARTBEAT MONITORING
        checkPartnerHeartbeat(data);

        // ... (Keep existing video ID and play/pause logic from 2. & 3. in the previous script)
        // ...
        
        // 4. TIME JUMP (Force Sync) - Now relies on primary sync data
        if (!dom.overlay.classList.contains('active')) {
            const serverTime = data.seekTime || 0;
            if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
                player.seekTo(serverTime, true);
            }
        }
        // ... (Keep existing else/empty queue logic)
    });
}


function checkPartnerHeartbeat(syncData) {
    database.ref('playerStatus').once('value', snapshot => {
        let isAnyPartnerLagging = false;
        
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            const partnerId = childSnap.key;
            
            // 1. Ignore my own heartbeat and players not on the current song
            // We use the playerRef key for comparison (which is unique to this browser instance)
            if (partnerId === playerRef.key || partnerData.queueIndex !== queueIndex) return; 

            // Calculate the age of the last update
            const timeSinceLastUpdate = Date.now() - partnerData.timestamp;

            // 2. AD/LAG DETECTION: Is the partner stuck or hasn't reported in > 5 seconds?
            // The ad is running if the last reported time is stale AND the player state is "play"
            if (timeSinceLastUpdate > 5000 && syncData.status === 'play' && !partnerData.isSeeking) {
                isAnyPartnerLagging = true;
                return; // Stop checking, we found a stuck partner
            }
        });

        // ACTION: If someone is lagging/watching an ad
        if (isAnyPartnerLagging) {
            dom.overlay.classList.add('active');
            dom.msg.innerText = "HEARTBEAT LOST. WAITING FOR SYNC...";
            if (myState === 1) player.pauseVideo();
            dom.disc.style.animationPlayState = 'paused';
            dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        } else {
            // ACTION: Everyone is synced or paused intentionally
            dom.overlay.classList.remove('active');
            
            // Re-apply the global play/pause status from Firebase
            if (syncData.status === 'play' && myState !== 1) {
                player.playVideo();
            } else if (syncData.status === 'pause' && myState === 1) {
                player.pauseVideo();
            }
        }
    });
}

// ... (Keep existing updateFirebase, togglePlay, syncSeek, playNext functions)
// ... (Keep existing SEARCH & QUEUE functions)
// ... (Keep existing UI HELPERS)

// Add the new functions and replace the old listenForSync logic with this structure.
