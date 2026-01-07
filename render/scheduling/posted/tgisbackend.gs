function doGet(e) {
  try {
    const username = e.parameter.user;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const timezone = Session.getScriptTimeZone();
    
    // 1. HELPER FUNCTION TO GET AND FORMAT DATA
    function getAllSheetData(sheetName) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) return []; 
      const headers = data[0].map(h => h.toString().trim());
      
      return data.slice(1).map(row => {
        let obj = {};
        headers.forEach((header, i) => {
          if (!header) return; 
          let value = row[i];
          
          if (Object.prototype.toString.call(value) === '[object Date]') {
            if (value.getFullYear() < 1910) { 
              // This is a time (e.g. 8:00 AM)
              value = Utilities.formatDate(value, timezone, "h:mm a");
            } else {
              // This is a calendar date (e.g. 2024-10-15)
              value = Utilities.formatDate(value, timezone, "yyyy-MM-dd");
            }
          }
          
          obj[header] = value;
        });
        return obj;
      });
    }

    // 2. REVISED HELPER FUNCTION TO GROUP TOURS (Incorporating Status)
    function groupToursBySlot(tours) {
      const tourSlots = {};
      
      tours.forEach(tour => {
        // ASSUMED HEADERS: Date, Time, DayOfWeek, TourType, GuideName, username, Status
        const date = tour.Date; 
        const time = tour.Time; 
        const key = `${date}|${time}`;
        
        if (!tourSlots[key]) {
          tourSlots[key] = {
            date: date,
            time: time,
            day: tour.DayOfWeek || '', 
            tour_type: tour.TourType || 'Daily Visit', 
            guides: [], 
          };
        }
        
        // Push the guide details including their status for this specific tour
        tourSlots[key].guides.push({
          name: tour.GuideName,
          username: tour.username,
          status: tour.Status || 'Scheduled' // Use 'Scheduled' as default
        });
      });
      
      return Object.values(tourSlots);
    }

    // 3. FETCH ALL RAW DATA
    const allDeskShifts = getAllSheetData("DeskShifts");
    const allTours = getAllSheetData("Tours"); 
    const allGuides = getAllSheetData("TourGuides");

    // 4. PROCESS DATA
    const guideProfile = allGuides.find(g => g.username.toLowerCase() === username.toLowerCase()) || null;
    
    // userTours for the current user must now include the Status
    const userTours = allTours.filter(t => t.username.toLowerCase() === username.toLowerCase()).map(t => ({
      ...t,
      status: t.Status || 'Scheduled'
    }));
    
    const groupedTours = groupToursBySlot(allTours); 

    // 5. BUILD RESPONSE
    const response = {
      guide: guideProfile,
      userTours: userTours, 
      groupedTours: groupedTours, // All tours grouped by slot, with guide status inside
      masterDeskSchedule: allDeskShifts,
      lastUpdated: new Date().toLocaleTimeString()
    };

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
