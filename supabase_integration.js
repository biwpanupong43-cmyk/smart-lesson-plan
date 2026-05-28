/**
 * supabase_integration.js
 * ──────────────────────────────────────────────────────────────
 * ไฟล์กลางสำหรับเชื่อมต่อ Supabase ทุกหน้าในระบบ Smart Lesson Plan
 * ──────────────────────────────────────────────────────────────
 */
'use strict';

// คีย์การเชื่อมต่อฐานข้อมูลของคุณ
const SUPABASE_URL      = 'https://aamnvfnhtvmxwypgiorq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhbW52Zm5odHZteHd5cGdpb3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTYwNDAsImV4cCI6MjA5NTE5MjA0MH0.dkvN9FVrz_ekrmvOUFOgGZxewG0S_tQyTJTp_kZeTVI';

// 🌟 แก้ไขจุดที่ทำให้เกิด Error 404: ปรับชื่อไฟล์ให้ตรงกับบน GitHub ของคุณครูเป๊ะๆ 🌟
const ROLE_ROUTES = { 
  teacher: 'teacher_dashboard.html', 
  director: 'director_dashboard.html', 
  admin: 'admin_dashboard.html' 
};

// บังคับให้เป็น Global Variable ป้องกันบัค db is not defined
const db = (typeof window._supabaseClient !== 'undefined') ? window._supabaseClient : (() => {
  const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window._supabaseClient = client; 
  return client;
})();
window.db = db; 

// ตรวจสอบสิทธิ์การเข้าหน้าเว็บ (Session Check)
(async () => {
  const currentPage = window.location.pathname.split('/').pop();
  const protectedPages = ['admin_dashboard.html', 'teacher_dashboard.html', 'director_dashboard.html', 'admin.html', 'teacher.html', 'director.html'];
  
  // ถ้าไม่ใช่หน้าที่ต้องล็อกอิน ปล่อยผ่าน
  if (!protectedPages.includes(currentPage)) return;

  const { data: { session } } = await window.db.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  let profile = JSON.parse(sessionStorage.getItem('userProfile') || 'null');
  if (!profile) {
    const { data, error } = await window.db.from('users').select('id, name, role, subject_group').eq('id', session.user.id).single();
    if (error || !data) { await window.db.auth.signOut(); window.location.href = 'index.html'; return; }
    profile = data; 
    sessionStorage.setItem('userProfile', JSON.stringify(profile));
  }
})();

// ── ฟังก์ชันจัดการผู้ใช้งาน ──────────────────────────────
async function addNewUser({ name, role, subject_group, username, temp_password }) {
  const email = `${username}@school.local`;
  const { data: authData, error: authErr } = await window.db.auth.signUp({ 
    email, password: temp_password, options: { data: { username, role } } 
  });
  if (authErr) throw new Error(`สร้าง Auth user ไม่สำเร็จ: ${authErr.message}`);

  const userId = authData.user?.id;
  const { error: insertErr } = await window.db.from('users').insert({ 
    id: userId, name: name, role: role, subject_group: subject_group || null, username: username, created_at: new Date().toISOString() 
  });
  if (insertErr) throw new Error(`บันทึก profile ไม่สำเร็จ: ${insertErr.message}`);
  return { id: userId, username, role };
}

async function getAllUsers() {
  const { data, error } = await window.db.from('users').select('id, name, role, subject_group, username, created_at').order('created_at', { ascending: true });
  if (error) throw new Error(`ดึงข้อมูลผู้ใช้ไม่สำเร็จ: ${error.message}`);
  return data || [];
}

// ── ฟังก์ชันจัดการระบบและฐานข้อมูล ──────────────────────────────
async function getSystemSetting(key) {
  const { data, error } = await window.db.from('system_settings').select('value').eq('key', key).single();
  if (error) return null; 
  return data?.value ?? null;
}

async function saveSystemSetting(key, value) {
  const { error } = await window.db.from('system_settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(`บันทึกการตั้งค่าไม่สำเร็จ: ${error.message}`);
}

async function resetDatabase() {
  const { error: plansErr } = await window.db.from('lesson_plans').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (plansErr) throw new Error(`ล้างข้อมูลแผนไม่สำเร็จ: ${plansErr.message}`);
}

// ── ฟังก์ชันการส่งและจัดการแผนการสอน ─────────────────
async function uploadPlanViaGAS(subject, weekLabel, file, gasUrl) {
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');
  if (!profile.id) throw new Error('ไม่พบข้อมูลผู้ใช้ กรุณา login ใหม่');

  const base64 = await _fileToBase64(file);
  const payload = { fileName: file.name, base64: base64, mimeType: file.type, subject: subject, week: weekLabel, teacherId: profile.id, teacherName: profile.name };

  const response = await fetch(gasUrl, { method: 'POST', body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`เครือข่ายขัดข้อง (Status ${response.status})`);

  const result = await response.json();
  
  if (!result.success && result.status !== 'success') {
    throw new Error(result.message || result.error || 'Google Apps Script ไม่สามารถส่งไฟล์ได้');
  }

  const driveUrl  = result.fileUrl || result.url || null;
  const aiSummary = result.summary || '-';
  const weekNumber = parseInt(weekLabel.replace(/[^0-9]/g, '')) || 0;

  const { error: insertErr } = await window.db.from('lesson_plans').insert({
    teacher_id:    profile.id,
    subject:       subject,
    subject_name:  subject, 
    week_number:   weekNumber,
    file_name:     file.name,
    file_url:      driveUrl, 
    ai_summary:    aiSummary,
    status:        'Pending',
    submitted_at:  new Date().toISOString(),
  });

  if (insertErr) throw new Error(`บันทึกข้อมูลแผนลงระบบไม่สำเร็จ: ${insertErr.message}`);
  return { driveUrl, aiSummary };
}

async function getMyPlans() {
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');
  const { data, error } = await window.db.from('lesson_plans').select('*').eq('teacher_id', profile.id).order('created_at', { ascending: false });
  if (error) throw new Error(`ดึงข้อมูลแผนของฉันไม่สำเร็จ: ${error.message}`);
  return data || [];
}

async function getAllPendingPlans() {
  const { data, error } = await window.db.from('lesson_plans').select(`*, users ( name, subject_group )`).eq('status', 'Pending').order('created_at', { ascending: true });
  if (error) throw new Error(`ดึงข้อมูลแผนที่รอตรวจไม่สำเร็จ: ${error.message}`);
  return data || [];
}

async function updatePlanStatus(planId, status, feedback = '') {
  const profile = JSON.parse(sessionStorage.getItem('userProfile') || '{}');
  const { error } = await window.db.from('lesson_plans').update({ 
    status: status, 
    director_feedback: feedback, 
    reviewed_by: profile.id, 
    updated_at: new Date().toISOString() 
  }).eq('id', planId);
  
  if (error) throw new Error(`อัปเดตสถานะการประเมินไม่สำเร็จ: ${error.message}`);
}

// ── ฟังก์ชันอรรถประโยชน์ ──────────────────────────────
async function signOut() {
  await window.db.auth.signOut();
  sessionStorage.removeItem('userProfile');
  window.location.href = 'index.html';
}
// ผูกไว้กับ window เพื่อเรียกใช้งานได้ง่ายในหน้า HTML
window._signOut = signOut;

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}
