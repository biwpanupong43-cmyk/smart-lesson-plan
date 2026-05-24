/**
 * supabase_integration.js
 * ──────────────────────────────────────────────────────────────
 * ไฟล์กลางสำหรับเชื่อมต่อ Supabase ทุกหน้าในระบบ Smart Lesson Plan
 * โหลดหลังจาก <script src="@supabase/supabase-js@2"> เสมอ
 * ──────────────────────────────────────────────────────────────
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
//  1. CONFIG — แก้ไขค่าตรงนี้ให้ตรงกับโปรเจกต์ Supabase ของคุณ
// ═══════════════════════════════════════════════════════════════
const SUPABASE_URL      = 'https://aamnvfnhtvmxwypgiorq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhbW52Zm5odHZteHd5cGdpb3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTYwNDAsImV4cCI6MjA5NTE5MjA0MH0.dkvN9FVrz_ekrmvOUFOgGZxewG0S_tQyTJTp_kZeTVI';

// เส้นทาง redirect ตาม role (ปรับตามโครงสร้างโฟลเดอร์ของคุณ)
const ROLE_ROUTES = {
  teacher:  'teacher_dashboard.html',
  director: 'director_dashboard.html',
  admin:    'admin_dashboard.html',
};

// ═══════════════════════════════════════════════════════════════
//  2. สร้าง Supabase Client (singleton — ใช้ร่วมกันทุกหน้า)
// ═══════════════════════════════════════════════════════════════
// ป้องกันการสร้างซ้ำถ้าหน้า index.html สร้างไว้แล้ว
const db = (typeof window._supabaseClient !== 'undefined')
  ? window._supabaseClient
  : (() => {
      const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      window._supabaseClient = client;
      return client;
    })();


// ═══════════════════════════════════════════════════════════════
//  3. AUTH GUARD — ป้องกันหน้า Dashboard ถ้ายังไม่ได้ login
//     ใส่ไว้ท้ายสุดของไฟล์ (auto-run)
// ═══════════════════════════════════════════════════════════════
(async () => {
  const currentPage = window.location.pathname.split('/').pop();
  const protectedPages = [
    'admin_dashboard.html',
    'teacher_dashboard.html',
    'director_dashboard.html',
  ];

  if (!protectedPages.includes(currentPage)) return; // index.html ข้ามไป

  const { data: { session } } = await db.auth.getSession();

  if (!session) {
    // ไม่มี session → กลับหน้า login
    window.location.href = 'index.html';
    return;
  }

  // โหลด profile จาก sessionStorage ก่อน (เร็วกว่า)
  let profile = JSON.parse(sessionStorage.getItem('userProfile') || 'null');

  if (!profile) {
    // ถ้าไม่มีใน sessionStorage → ดึงจาก DB แล้วบันทึก
    const { data, error } = await db
      .from('users')
      .select('id, name, role, subject_group')
      .eq('id', session.user.id)
      .single();

    if (error || !data) {
      await db.auth.signOut();
      window.location.href = 'index.html';
      return;
    }

    profile = data;
    sessionStorage.setItem('userProfile', JSON.stringify(profile));
  }

  // ตรวจสอบว่าอยู่หน้าที่ตรงกับ role หรือเปล่า
  const expectedPage = ROLE_ROUTES[profile.role];
  if (expectedPage && currentPage !== expectedPage) {
    window.location.href = expectedPage;
  }
})();


// ═══════════════════════════════════════════════════════════════
//  4. ADMIN FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * addNewUser — สร้างบัญชีผู้ใช้ใหม่ใน Supabase Auth + ตาราง users
 *
 * @param {{ name:string, role:string, subject_group:string,
 *           username:string, temp_password:string }} userData
 *
 * ⚠️  ต้องการให้ปิด "Email Confirmation" ใน Supabase Dashboard
 *     Authentication → Settings → Email → Confirm email: OFF
 *
 * ถ้าต้องการสร้างโดยไม่ให้ผู้ใช้ต้อง confirm email ควรใช้
 * Supabase Edge Function + service_role key แทน (แนะนำสำหรับ production)
 */
async function addNewUser({ name, role, subject_group, username, temp_password }) {
  // แปลง username เป็น email (รูปแบบเดียวกับ login)
  const email = `${username}@school.local`;

  // ── ขั้นที่ 1: สร้าง Auth user ──────────────────────────────
  const { data: authData, error: authErr } = await db.auth.signUp({
    email,
    password: temp_password,
    options: {
      // ฝัง username ไว้ใน user_metadata ด้วย (สะดวกเวลาดึงข้อมูล)
      data: { username, role },
    },
  });

  if (authErr) {
    // แปลงข้อความ error เป็นภาษาไทย
    if (authErr.message.includes('already registered')) {
      throw new Error(`Username "${username}" ถูกใช้งานไปแล้ว`);
    }
    throw new Error(`สร้าง Auth user ไม่สำเร็จ: ${authErr.message}`);
  }

  const userId = authData.user?.id;
  if (!userId) throw new Error('ไม่ได้รับ user ID จาก Supabase Auth');

  // ── ขั้นที่ 2: บันทึกลงตาราง users ─────────────────────────
  const { error: insertErr } = await db.from('users').insert({
    id:            userId,
    name:          name,
    role:          role,
    subject_group: subject_group || null,
    username:      username,
    created_at:    new Date().toISOString(),
  });

  if (insertErr) {
    throw new Error(`บันทึก profile ไม่สำเร็จ: ${insertErr.message}`);
  }

  console.log(`✅ สร้างบัญชี ${username} (${role}) สำเร็จ`);
  return { id: userId, username, role };
}


/**
 * resetDatabase — ลบข้อมูล lesson_plans ทั้งหมด
 * (ไม่ลบบัญชีผู้ใช้ เพื่อความปลอดภัย — ถ้าต้องการลบผู้ใช้ด้วย
 *  ต้องใช้ service_role key ผ่าน Edge Function)
 */
async function resetDatabase() {
  // ลบแผนการสอนทั้งหมด
  const { error: plansErr } = await db
    .from('lesson_plans')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000'); // trick ลบทุก row

  if (plansErr) throw new Error(`ล้าง lesson_plans ไม่สำเร็จ: ${plansErr.message}`);

  console.log('✅ Factory reset เสร็จสิ้น');
}


// ═══════════════════════════════════════════════════════════════
//  5. TEACHER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * uploadPlanViaGAS — ส่งไฟล์ PDF ไปยัง Google Apps Script
 * แล้วบันทึก metadata ลง Supabase
 *
 * @param {string} subject    วิชา เช่น "วิทยาศาสตร์ ม.1"
 * @param {string} weekLabel  สัปดาห์ เช่น "สัปดาห์ที่ 2"
 * @param {File}   file       ไฟล์ PDF
 * @param {string} gasUrl     URL ของ Google Apps Script Web App
 */
async function uploadPlanViaGAS(subject, weekLabel, file, gasUrl) {
  // ── ดึง profile ของครูที่ login อยู่ ──
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');
  if (!profile.id) throw new Error('ไม่พบข้อมูลผู้ใช้ กรุณา login ใหม่');

  // ── แปลงไฟล์เป็น Base64 ──────────────────────────────────────
  const base64 = await _fileToBase64(file);

  // ── ส่ง request ไปยัง GAS ────────────────────────────────────
  const payload = {
    fileName:    file.name,
    fileBase64:  base64,
    mimeType:    file.type,
    subject:     subject,
    week:        weekLabel,
    teacherId:   profile.id,
    teacherName: profile.name,
  };

  const response = await fetch(gasUrl, {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`GAS ตอบกลับ ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || 'GAS ส่งไฟล์ไม่สำเร็จ');
  }

  const driveUrl  = result.fileUrl  || null;
  const driveId   = result.fileId   || null;
  const aiSummary = result.summary  || null;

  // ── บันทึก metadata ลง Supabase ─────────────────────────────
  const weekNumber = parseInt(weekLabel.replace(/[^0-9]/g, '')) || 0;

  const { error: insertErr } = await db.from('lesson_plans').insert({
    teacher_id:    profile.id,
    subject:       subject,
    week_number:   weekNumber,
    file_name:     file.name,
    drive_url:     driveUrl,
    drive_file_id: driveId,
    ai_summary:    aiSummary,
    status:        'Pending',
    submitted_at:  new Date().toISOString(),
  });

  if (insertErr) {
    throw new Error(`บันทึกข้อมูลแผนไม่สำเร็จ: ${insertErr.message}`);
  }

  console.log(`✅ ส่งแผน "${subject}" สัปดาห์ที่ ${weekNumber} สำเร็จ`);
  return { driveUrl, aiSummary };
}


/**
 * getMyPlans — ดึงประวัติแผนการสอนของครูที่ login อยู่
 * @returns {Array} รายการแผนการสอน เรียงจากใหม่ไปเก่า
 */
async function getMyPlans() {
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');
  if (!profile.id) throw new Error('ไม่พบข้อมูลผู้ใช้');

  const { data, error } = await db
    .from('lesson_plans')
    .select('*')
    .eq('teacher_id', profile.id)
    .order('submitted_at', { ascending: false });

  if (error) throw new Error(`ดึงข้อมูลแผนไม่สำเร็จ: ${error.message}`);
  return data || [];
}


// ═══════════════════════════════════════════════════════════════
//  6. DIRECTOR FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * getAllPendingPlans — ดึงแผนที่รอการอนุมัติทั้งหมด (director ใช้)
 */
async function getAllPendingPlans() {
  const { data, error } = await db
    .from('lesson_plans')
    .select(`
      *,
      users ( name, subject_group )
    `)
    .eq('status', 'Pending')
    .order('submitted_at', { ascending: true });

  if (error) throw new Error(`ดึงข้อมูลแผนไม่สำเร็จ: ${error.message}`);
  return data || [];
}

/**
 * updatePlanStatus — อนุมัติหรือส่งกลับแก้ไขแผนการสอน
 *
 * @param {string} planId   UUID ของแผน
 * @param {'Approved'|'Revision Needed'} status
 * @param {string} feedback ความคิดเห็น
 */
async function updatePlanStatus(planId, status, feedback = '') {
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');

  const { error } = await db
    .from('lesson_plans')
    .update({
      status:       status,
      feedback:     feedback,
      reviewed_by:  profile.id,
      reviewed_at:  new Date().toISOString(),
    })
    .eq('id', planId);

  if (error) throw new Error(`อัปเดตสถานะไม่สำเร็จ: ${error.message}`);
  console.log(`✅ แผน ${planId} → ${status}`);
}


// ═══════════════════════════════════════════════════════════════
//  7. SETTINGS FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * getSystemSetting / saveSystemSetting
 * ใช้ตาราง system_settings (key TEXT PRIMARY KEY, value TEXT)
 */
async function getSystemSetting(key) {
  const { data, error } = await db
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error) return null;
  return data?.value ?? null;
}

async function saveSystemSetting(key, value) {
  const { error } = await db
    .from('system_settings')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) throw new Error(`บันทึกการตั้งค่าไม่สำเร็จ: ${error.message}`);
}


// ═══════════════════════════════════════════════════════════════
//  8. USER MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════

/**
 * getAllUsers — ดึงรายชื่อผู้ใช้ทั้งหมด (ยกเว้น admin เอง)
 */
async function getAllUsers() {
  const { data, error } = await db
    .from('users')
    .select('id, name, role, subject_group, username, created_at')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`ดึงข้อมูลผู้ใช้ไม่สำเร็จ: ${error.message}`);
  return data || [];
}

/**
 * updateUser — แก้ไขข้อมูลผู้ใช้ (ชื่อ, role, กลุ่มสาระ)
 */
async function updateUser(userId, { name, role, subject_group }) {
  const { error } = await db
    .from('users')
    .update({ name, role, subject_group })
    .eq('id', userId);

  if (error) throw new Error(`แก้ไขผู้ใช้ไม่สำเร็จ: ${error.message}`);
}


// ═══════════════════════════════════════════════════════════════
//  9. LOGOUT (ใช้ร่วมกัน)
// ═══════════════════════════════════════════════════════════════

async function signOut() {
  await db.auth.signOut();
  sessionStorage.removeItem('userProfile');
  window.location.href = 'index.html';
}

// ── Override ฟังก์ชัน logout() ที่แต่ละหน้าเรียก ──
// (แต่ละหน้า define logout() ไว้แล้ว ฟังก์ชันนี้ทำหน้าที่ backup)
window._signOut = signOut;


// ═══════════════════════════════════════════════════════════════
//  10. UTILITIES (private)
// ═══════════════════════════════════════════════════════════════

/** แปลง File object เป็น base64 string */
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

/** แสดง toast สำเร็จ (SweetAlert2) */
function _toastOk(msg) {
  if (typeof Swal !== 'undefined') {
    Swal.fire({ toast:true, position:'bottom-end', icon:'success', title:msg,
      showConfirmButton:false, timer:2500, background:'#18181b', color:'#e4e4e7' });
  }
}

/** แสดง toast error (SweetAlert2) */
function _toastErr(msg) {
  if (typeof Swal !== 'undefined') {
    Swal.fire({ toast:true, position:'bottom-end', icon:'error', title:msg,
      showConfirmButton:false, timer:3500, background:'#18181b', color:'#e4e4e7' });
  }
}
