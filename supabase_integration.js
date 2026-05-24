// ============================================================
// PHASE 6: Supabase JS Integration
// Include via CDN in your HTML:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// Or install: npm install @supabase/supabase-js
// ============================================================

// ─── CONFIGURATION ──────────────────────────────────────────
const SUPABASE_URL      = 'https://aamnvfnhtvmxwypgiorq.supabase.co';   // ← replace
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhbW52Zm5odHZteHd5cGdpb3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTYwNDAsImV4cCI6MjA5NTE5MjA0MH0.dkvN9FVrz_ekrmvOUFOgGZxewG0S_tQyTJTp_kZeTVI';            // ← replace
// ────────────────────────────────────────────────────────────

// ── 1. initSupabase ──────────────────────────────────────────
/**
 * Creates and returns the Supabase client.
 * Call once on page load and store the result.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function initSupabase() {
  const { createClient } = supabase; // from CDN global
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

// Singleton client — call initSupabase() once at startup
const supabaseClient = initSupabase();


// ── 2. login ─────────────────────────────────────────────────
/**
 * Authenticates a user with username (stored as email alias) and password.
 *
 * NOTE: Supabase Auth uses email+password. Map username → email by looking up
 * the users table first, then sign in via Supabase Auth magic link or
 * store users in auth.users with <username>@school.local as email.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{user, session, profile}>}
 */
async function login(username, password) {
  try {
    // Map username to email format used during registration
    const email = `${username}@school.local`;

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    // Fetch the user's profile from the users table
    const { data: profile, error: profileError } = await supabaseClient
      .from('users')
      .select('id, name, role, subject_group')
      .eq('id', data.user.id)
      .single();

    if (profileError) throw profileError;

    Swal.fire({
      toast: true, position: 'bottom-end',
      icon: 'success', title: `ยินดีต้อนรับ, ${profile.name}`,
      showConfirmButton: false, timer: 2500,
    });

    return { user: data.user, session: data.session, profile };

  } catch (err) {
    console.error('[login]', err.message);
    Swal.fire({ icon: 'error', title: 'เข้าสู่ระบบไม่สำเร็จ', text: err.message });
    return null;
  }
}


// ── 3. getPendingPlans ───────────────────────────────────────
/**
 * Fetches all lesson plans with status = 'Pending'.
 * Joins the users table to include the teacher's name.
 *
 * @returns {Promise<Array>}
 */
async function getPendingPlans() {
  try {
    const { data, error } = await supabaseClient
      .from('lesson_plans')
      .select(`
        id,
        subject_name,
        week_number,
        status,
        file_url,
        ai_summary,
        created_at,
        users!teacher_id ( id, name, subject_group )
      `)
      .eq('status', 'Pending')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Flatten for convenience: attach teacher_name at top level
    return data.map(plan => ({
      ...plan,
      teacher_name: plan.users?.name ?? 'ไม่ทราบชื่อ',
      subject_group: plan.users?.subject_group ?? '',
    }));

  } catch (err) {
    console.error('[getPendingPlans]', err.message);
    Swal.fire({ icon: 'error', title: 'โหลดข้อมูลไม่สำเร็จ', text: err.message });
    return [];
  }
}


// ── 4. updatePlanStatus ──────────────────────────────────────
/**
 * Updates a lesson plan's status and director feedback.
 *
 * @param {string} planId    - UUID of the lesson plan
 * @param {'Approved'|'Revision Needed'|'Pending'} status
 * @param {string} [feedback] - Director's comment (optional)
 * @returns {Promise<boolean>} true on success
 */
async function updatePlanStatus(planId, status, feedback = '') {
  try {
    if (!planId || !status) throw new Error('planId and status are required');

    const updates = {
      status,
      director_feedback: feedback || null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabaseClient
      .from('lesson_plans')
      .update(updates)
      .eq('id', planId);

    if (error) throw error;

    const label = status === 'Approved' ? 'อนุมัติแล้ว' : 'ส่งกลับแก้ไข';
    Swal.fire({
      toast: true, position: 'bottom-end',
      icon: 'success', title: `อัปเดตสำเร็จ: ${label}`,
      showConfirmButton: false, timer: 2500,
    });

    return true;

  } catch (err) {
    console.error('[updatePlanStatus]', err.message);
    Swal.fire({ icon: 'error', title: 'อัปเดตไม่สำเร็จ', text: err.message });
    return false;
  }
}


// ── 5. addNewUser ────────────────────────────────────────────
/**
 * Inserts a new teacher (or director) into the users table.
 * Also creates a Supabase Auth account using the temp password.
 *
 * @param {{ name: string, role: string, subject_group: string, username: string, temp_password: string }} userData
 * @returns {Promise<boolean>} true on success
 */
async function addNewUser(userData) {
  try {
    const { name, role, subject_group, username, temp_password } = userData;

    // Validate required fields
    if (!name || !role || !username || !temp_password) {
      throw new Error('กรุณากรอกข้อมูลที่จำเป็นให้ครบ (name, role, username, temp_password)');
    }

    // Step 1: Create Supabase Auth user
    // Use admin API if available, otherwise sign up directly (dev only)
    const email = `${username}@school.local`;
    const { data: authData, error: authError } = await supabaseClient.auth.signUp({
      email,
      password: temp_password,
    });

    if (authError) throw authError;

    const newUserId = authData.user?.id;
    if (!newUserId) throw new Error('ไม่สามารถสร้างบัญชี Auth ได้');

    // Step 2: Insert profile into users table
    const { error: insertError } = await supabaseClient
      .from('users')
      .insert({
        id:            newUserId,
        name,
        role,
        subject_group: subject_group || null,
        username,
        temp_password, // plain text for initial handoff; change after first login
      });

    if (insertError) throw insertError;

    Swal.fire({
      icon: 'success',
      title: 'เพิ่มผู้ใช้สำเร็จ',
      html: `<p>บัญชี <strong>${username}</strong> ถูกสร้างเรียบร้อยแล้ว</p>
             <p style="font-size:13px;color:#6b7280;margin-top:8px">รหัสผ่านเริ่มต้น: <code>${temp_password}</code></p>`,
      confirmButtonColor: '#7c3aed',
    });

    return true;

  } catch (err) {
    console.error('[addNewUser]', err.message);
    Swal.fire({ icon: 'error', title: 'เพิ่มผู้ใช้ไม่สำเร็จ', text: err.message });
    return false;
  }
}


// ── Bonus: uploadPlan (Teacher) ───────────────────────────────
/**
 * Converts a File to base64 and sends to the GAS backend.
 * Then saves the returned fileUrl + aiSummary to Supabase.
 *
 * @param {string} GAS_URL   - Deployed Google Apps Script Web App URL
 * @param {string} teacherId - UUID of the logged-in teacher
 * @param {string} subject   - Subject name
 * @param {number} week      - Week number
 * @param {File}   file      - PDF File object
 */
async function uploadPlan(GAS_URL, teacherId, subject, week, file) {
  try {
    // Convert file to base64
    const base64 = await fileToBase64(file);

    // Send to GAS backend
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, base64 }),
    });

    if (!res.ok) throw new Error(`GAS error: ${res.status}`);

    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'Upload failed');

    // Save record to Supabase
    const { error } = await supabaseClient.from('lesson_plans').insert({
      teacher_id:   teacherId,
      subject_name: subject,
      week_number:  week,
      status:       'Pending',
      file_url:     json.fileUrl,
      ai_summary:   json.aiSummary,
    });

    if (error) throw error;

    Swal.fire({ icon: 'success', title: 'ส่งสำเร็จ!', text: 'แผนการสอนถูกส่งและวิเคราะห์โดย AI แล้ว', confirmButtonColor: '#3b82f6' });
    return true;

  } catch (err) {
    console.error('[uploadPlan]', err.message);
    Swal.fire({ icon: 'error', title: 'ส่งไม่สำเร็จ', text: err.message });
    return false;
  }
}

/** Helper: File → base64 string */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}


// ── Export for module environments ───────────────────────────
// If using ES modules (import/export), uncomment the line below:
// export { initSupabase, login, getPendingPlans, updatePlanStatus, addNewUser, uploadPlan };
