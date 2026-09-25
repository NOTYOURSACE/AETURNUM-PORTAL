const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// cors() first so even error responses carry CORS headers; raised body limit for avatar images
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Global Request Logger
app.use((req, res, next) => {
  console.log(`📥 INCOMING REQUEST: ${req.method} ${req.url}`);
  next();
});

// Helpers
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Never send stored passwords back to the browser
const stripPassword = (user) => {
  if (!user) return user;
  const { password, ...safe } = user;
  return safe;
};

// Connect to MongoDB using direct shard connection string
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return;
  
  const atlasURI = process.env.MONGODB_URI;
  if (!atlasURI) throw new Error('MONGODB_URI is not set');

  console.log('🔄 Connecting to MongoDB cluster...');
   await mongoose.connect(atlasURI, {
    serverSelectionTimeoutMS: 15000
  });
  
  console.log(`📂 Connected successfully to MongoDB Database!`);
};

// Root Route
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Aeturnum Portal Backend is live!' });
});

// Safe GET Users Route
app.get('/api/users', async (req, res) => {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database connection not established");
    
    const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
    return res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err.message);
    return res.status(500).json({ error: 'Error fetching users: ' + err.message });
  }
});

// POST Login Route
app.post('/api/login', async (req, res) => {
  try {
    console.log('🎯 /api/login route hit');
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const { username, password } = req.body;
    const trimmedInput = username ? username.trim() : '';
    const trimmedPassword = password ? String(password).trim() : '';

    if (!trimmedInput || !trimmedPassword) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await db.collection('users').findOne({
      $or: [
        { id: { $regex: new RegExp(`^${escapeRegex(trimmedInput)}$`, 'i') } },
        { username: { $regex: new RegExp(`^${escapeRegex(trimmedInput)}$`, 'i') } }
      ]
    });

    if (!user) {
      console.log('❌ User not found:', trimmedInput);
      return res.status(404).json({ error: 'User not found' });
    }

    const dbPassword = user.password ? String(user.password).trim() : '';
    if (dbPassword !== trimmedPassword) {
      console.log('❌ Incorrect password for:', trimmedInput);
      return res.status(401).json({ error: 'Incorrect password' });
    }

    console.log('✅ Successful login for user:', user.id || user.name);
    return res.json({ success: true, user: stripPassword(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Server error during login: ' + err.message });
  }
});

// PUT Route to Update User Details
app.put('/api/users/:id', async (req, res) => {
  try {
    const targetId = req.params.id;
    const updateData = req.body;
    console.log(`📥 Update request for user ID: ${targetId}`, {
      ...updateData,
      avatar: updateData.avatar ? '[image data]' : undefined,
      password: updateData.password ? '[hidden]' : undefined
    });

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    delete updateData._id;
    // Don't overwrite the stored password / photo with empty values
    if (!updateData.password) delete updateData.password;
    if (!updateData.avatar) delete updateData.avatar;

    // The dashboard sends the Mongo _id in the URL, so match on _id as well as id/username/name
    const idClauses = [{ id: targetId }, { username: targetId }, { name: targetId }];
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      idClauses.unshift({ _id: new mongoose.Types.ObjectId(targetId) });
    }

    const result = await db.collection('users').findOneAndUpdate(
      { $or: idClauses },
      { $set: updateData },
      { returnDocument: 'after' }
    );

    // MongoDB driver v5 returns { value: doc }, v6+ returns the doc itself
    const updatedUser = result && result.lastErrorObject !== undefined ? result.value : result;

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found in database for update' });
    }

    console.log('✅ User successfully updated');
    return res.json({ success: true, user: stripPassword(updatedUser) });
  } catch (err) {
    console.error('Update error:', err.message);
    return res.status(500).json({ error: 'Server error during update: ' + err.message });
  }
});

// POST Create New User Route
app.post('/api/users', async (req, res) => {
  try {
    console.log('🎯 /api/users POST route hit', {
      ...req.body,
      avatar: req.body.avatar ? '[image data]' : undefined,
      password: req.body.password ? '[hidden]' : undefined
    });
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const userData = req.body;
    if (!userData.id || !userData.name) {
      return res.status(400).json({ error: 'User ID and Name are required' });
    }

    const existingUser = await db.collection('users').findOne({ 
      $or: [{ id: userData.id }, { username: userData.id }] 
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User ID already exists in database' });
    }

    const newUser = {
      ...userData,
      password: userData.password || 'Aeturnum123',
      createdAt: new Date()
    };

    await db.collection('users').insertOne(newUser);

    console.log('✅ New user successfully created:', newUser.id);
    return res.status(201).json({ success: true, user: stripPassword(newUser) });
  } catch (err) {
    console.error('Create user error:', err.message);
    return res.status(500).json({ error: 'Server error during user creation: ' + err.message });
  }
});

// ==================== QA EVALUATIONS ROUTES ====================

app.post('/api/evaluations', async (req, res) => {
  try {
    console.log('🎯 /api/evaluations POST route hit', req.body);
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const {
      qaId, agentId, agentName, client, clientPhone, callRef, saleId, date, score,
      adherence, result, criticalFail, evaluator, notes, checklist
    } = req.body;

    // qaId is optional now: the server creates one when the QA dashboard does not send it
    const missing = [];
    if (!agentId) missing.push('agentId');
    if (!client) missing.push('client');
    if (score === undefined || score === null || score === '') missing.push('score');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required evaluation fields: ${missing.join(', ')}` });
    }
    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({ error: 'Score must be a number' });
    }

    const newEvaluation = {
      qaId: qaId || `QA-${Date.now().toString(36).toUpperCase()}`,
      agentId: String(agentId).trim(),
      agentName: agentName || '',
      client,
      clientPhone: clientPhone || '',
      callRef: callRef || '',
      saleId: saleId ? String(saleId) : '',
      date: date || new Date().toISOString().split('T')[0],
      score: Number(score),
      adherence: adherence || 'Standard',
      result: result || '',
      criticalFail: Boolean(criticalFail),
      evaluator: evaluator || 'QA Supervisor',
      notes: notes || '',
      checklist: Array.isArray(checklist) ? checklist : [],
      createdAt: new Date()
    };

    await db.collection('evaluations').insertOne(newEvaluation);

    console.log(`✅ QA evaluation ${newEvaluation.qaId} successfully saved for agent: ${agentId}`);
    return res.status(201).json({ success: true, evaluation: newEvaluation });
  } catch (err) {
    console.error('Create evaluation error:', err.message);
    return res.status(500).json({ error: 'Server error during evaluation creation: ' + err.message });
  }
});

// Every evaluation, for the QA dashboard (overview + call history)
app.get('/api/evaluations', async (req, res) => {
  try {
    console.log('📥 Fetching all QA evaluations');
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const evaluations = await db.collection('evaluations')
      .find({})
      .sort({ createdAt: -1 })
      .limit(2000)
      .toArray();

    return res.json({ success: true, evaluations });
  } catch (err) {
    console.error('Fetch all evaluations error:', err.message);
    return res.status(500).json({ error: 'Server error fetching evaluations: ' + err.message });
  }
});

app.get('/api/evaluations/agent/:agentId', async (req, res) => {
  try {
    const targetAgentId = req.params.agentId;
    console.log(`📥 Fetching QA evaluations for agent ID: ${targetAgentId}`);

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const evaluations = await db.collection('evaluations')
      .find({ agentId: targetAgentId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, evaluations });
  } catch (err) {
    console.error('Fetch evaluations error:', err.message);
    return res.status(500).json({ error: 'Server error fetching evaluations: ' + err.message });
  }
});

app.get('/api/evaluations/ceo-summary', async (req, res) => {
  try {
    console.log(`📥 Fetching CEO summary evaluation metrics`);

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const evaluations = await db.collection('evaluations').find({}).toArray();
    
    let totalEvaluations = evaluations.length;
    let companyAverage = 0;

    if (totalEvaluations > 0) {
      const totalScore = evaluations.reduce((acc, curr) => acc + (Number(curr.score) || 0), 0);
      companyAverage = Number((totalScore / totalEvaluations).toFixed(2));
    }

    return res.json({
      success: true,
      totalEvaluations,
      companyAverage,
      evaluations
    });
  } catch (err) {
    console.error('Fetch CEO summary error:', err.message);
    return res.status(500).json({ error: 'Server error fetching CEO summary: ' + err.message });
  }
});

// ==================== SALES ====================
// Agents submit sales here. QA/CEO accounts review and approve/reject them.

const SALES_STATUSES = ['Pending QA Review', 'Approved by QA', 'Rejected'];

// Agent submits a new sale
app.post('/api/sales', async (req, res) => {
  try {
    console.log('🎯 /api/sales POST route hit', req.body);
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const {
      agentId,
      agentName,
      clientName,
      clientPhone,
      packageTier,
      saleAmount,
      notes
    } = req.body;

    if (!agentId || !clientName) {
      return res.status(400).json({ error: 'Agent ID and client name are required' });
    }

    const newSale = {
      id: `SALE-${Math.floor(1000 + Math.random() * 9000)}`,
      date: new Date().toISOString().split('T')[0],
      agentId: String(agentId).trim(),
      agentName: agentName || String(agentId),
      clientName: String(clientName).trim(),
      clientPhone: clientPhone || '',
      packageTier: packageTier || '',
      saleAmount: saleAmount || '',
      notes: notes || '',
      qaStatus: 'Pending QA Review',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date()
    };

    await db.collection('sales').insertOne(newSale);

    console.log(`✅ Sale ${newSale.id} successfully saved for agent: ${newSale.agentId}`);
    return res.status(201).json({ success: true, sale: newSale });
  } catch (err) {
    console.error('Create sale error:', err.message);
    return res.status(500).json({ error: 'Server error during sale creation: ' + err.message });
  }
});

// All sales, for the CEO / QA dashboard
app.get('/api/sales', async (req, res) => {
  try {
    console.log('📥 Fetching all sales');
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const filter = {};
    if (req.query.status) filter.qaStatus = req.query.status;

    const sales = await db.collection('sales')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, sales });
  } catch (err) {
    console.error('Fetch sales error:', err.message);
    return res.status(500).json({ error: 'Server error fetching sales: ' + err.message });
  }
});

// An agent's own sales
app.get('/api/sales/agent/:agentId', async (req, res) => {
  try {
    const targetAgentId = req.params.agentId;
    console.log(`📥 Fetching sales for agent ID: ${targetAgentId}`);

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const sales = await db.collection('sales')
      .find({ agentId: targetAgentId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, sales });
  } catch (err) {
    console.error('Fetch agent sales error:', err.message);
    return res.status(500).json({ error: 'Server error fetching sales: ' + err.message });
  }
});

// QA / CEO approves or rejects a sale
app.put('/api/sales/:id', async (req, res) => {
  try {
    const { qaStatus, reviewedBy, reviewComment } = req.body;

    if (!SALES_STATUSES.includes(qaStatus)) {
      return res.status(400).json({ error: `Status must be one of: ${SALES_STATUSES.join(', ')}` });
    }

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ error: 'Database connection failed' });

    const result = await db.collection('sales').findOneAndUpdate(
      { id: req.params.id },
      {
        $set: {
          qaStatus,
          reviewedBy: reviewedBy || 'QA Supervisor',
          reviewedAt: new Date(),
          ...(reviewComment !== undefined ? { reviewComment: String(reviewComment) } : {})
        }
      },
      { returnDocument: 'after' }
    );

    // MongoDB driver v5 returns { value: doc }, v6+ returns the doc itself
    const updated = result && result.lastErrorObject !== undefined ? result.value : result;

    if (!updated) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    console.log(`✅ Sale ${req.params.id} marked ${qaStatus} by ${updated.reviewedBy}`);
    return res.json({ success: true, sale: updated });
  } catch (err) {
    console.error('Review sale error:', err.message);
    return res.status(500).json({ error: 'Server error reviewing sale: ' + err.message });
  }
});

// ==================== ATTENDANCE ====================
// Agents check in once per day; the frontend calls GET to load today's/past
// logs and POST each time "Check In" is pressed.

// An agent's own attendance logs
app.get('/api/attendance/agent/:agentId', async (req, res) => {
  try {
    const targetAgentId = req.params.agentId;
    console.log(`📥 Fetching attendance for agent ID: ${targetAgentId}`);

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const logs = await db.collection('attendance')
      .find({ agentId: targetAgentId })
      .sort({ date: -1 })
      .toArray();

    return res.json({ success: true, logs });
  } catch (err) {
    console.error('Fetch attendance error:', err.message);
    return res.status(500).json({ error: 'Server error fetching attendance: ' + err.message });
  }
});

// All attendance, for the Team Lead / CEO dashboard
app.get('/api/attendance', async (req, res) => {
  try {
    console.log('📥 Fetching all attendance');
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const filter = {};
    if (req.query.date) filter.date = req.query.date;

    const logs = await db.collection('attendance')
      .find(filter)
      .sort({ date: -1 })
      .toArray();

    return res.json({ success: true, logs });
  } catch (err) {
    console.error('Fetch all attendance error:', err.message);
    return res.status(500).json({ error: 'Server error fetching attendance: ' + err.message });
  }
});

// Record a check-in (one per agent per day - upsert so re-checking in the
// same day updates the existing record instead of creating a duplicate)
app.post('/api/attendance', async (req, res) => {
  try {
    console.log('🎯 /api/attendance POST route hit', req.body);
    await connectDB();

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const {
      agentId,
      agentName,
      date,
      checkInTime,
      lateArrival,
      earlyDeparture,
      breakTime,
      netPortalTime,
      status
    } = req.body;

    if (!agentId || !date) {
      return res.status(400).json({ error: 'Agent ID and date are required' });
    }

    const record = {
      agentId: String(agentId).trim(),
      agentName: agentName || String(agentId),
      date,
      checkInTime: checkInTime || '',
      lateArrival: lateArrival || '',
      earlyDeparture: earlyDeparture || '',
      breakTime: breakTime || '',
      netPortalTime: netPortalTime || '',
      status: status || 'Available',
      updatedAt: new Date()
    };

    const result = await db.collection('attendance').findOneAndUpdate(
      { agentId: record.agentId, date: record.date },
      { $set: record, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );

    // MongoDB driver v5 returns { value: doc }, v6+ returns the doc itself
    const savedLog = result && result.lastErrorObject !== undefined ? result.value : result;

    console.log(`✅ Attendance recorded for agent: ${record.agentId} on ${record.date}`);
    return res.status(201).json({ success: true, log: savedLog || record });
  } catch (err) {
    console.error('Create attendance error:', err.message);
    return res.status(500).json({ error: 'Server error recording attendance: ' + err.message });
  }
});

// ==================== LEAVE / APPROVAL REQUESTS ====================
// Employees submit leave requests. Team Lead and CEO accounts review them.

const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Annual Leave', 'Emergency Leave', 'Half Day', 'Other'];

const isReviewerUser = (user) =>
  /ceo|team\s*lead/i.test(`${user.role || ''} ${user.designation || ''}`) ||
  /^ceo/i.test(String(user.id || user.username || ''));

const findUserByAnyId = (db, rawId) => {
  const clauses = [{ id: rawId }, { username: rawId }];
  if (mongoose.Types.ObjectId.isValid(rawId)) {
    clauses.unshift({ _id: new mongoose.Types.ObjectId(rawId) });
  }
  return db.collection('users').findOne({ $or: clauses });
};

// Look up the reviewer in the database and confirm they are a Team Lead or CEO
const getReviewer = async (db, reviewerId) => {
  if (!reviewerId) return null;
  const user = await findUserByAnyId(db, String(reviewerId));
  return user && isReviewerUser(user) ? user : null;
};

const reviewerKeys = (reviewer) =>
  [reviewer.id, reviewer.username, reviewer._id && String(reviewer._id)].filter(Boolean).map(String);

// Employee submits a leave request
app.post('/api/leave-requests', async (req, res) => {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ error: 'Database connection failed' });

    const { employeeId, employeeName, role, department, leaveType, fromDate, toDate, reason } = req.body;

    if (!employeeId || !leaveType || !fromDate || !toDate || !reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Leave type, dates and reason are required' });
    }
    if (!LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({ error: 'Invalid leave type' });
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (to < from) {
      return res.status(400).json({ error: "The 'To' date cannot be before the 'From' date" });
    }

    const newRequest = {
      employeeId: String(employeeId).trim(),
      employeeName: employeeName || String(employeeId),
      role: role || '',
      department: department || '',
      leaveType,
      fromDate,
      toDate,
      days: Math.round((to - from) / 86400000) + 1,
      reason: String(reason).trim(),
      status: 'Pending',
      reviewedBy: null,
      reviewerRole: null,
      reviewComment: '',
      reviewedAt: null,
      createdAt: new Date()
    };

    await db.collection('leave_requests').insertOne(newRequest);
    console.log(`✅ Leave request created by ${newRequest.employeeId} (${newRequest.days} day/s)`);
    return res.status(201).json({ success: true, request: newRequest });
  } catch (err) {
    console.error('Create leave request error:', err.message);
    return res.status(500).json({ error: 'Server error creating leave request: ' + err.message });
  }
});

// An employee's own requests
app.get('/api/leave-requests/employee/:employeeId', async (req, res) => {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ error: 'Database connection failed' });

    const requests = await db.collection('leave_requests')
      .find({ employeeId: req.params.employeeId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, requests });
  } catch (err) {
    console.error('Fetch own leave requests error:', err.message);
    return res.status(500).json({ error: 'Server error fetching leave requests: ' + err.message });
  }
});

// All requests for Team Lead / CEO accounts (a reviewer's own requests are left out of their queue)
app.get('/api/leave-requests', async (req, res) => {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ error: 'Database connection failed' });

    const reviewer = await getReviewer(db, req.query.reviewerId);
    if (!reviewer) {
      return res.status(403).json({ error: 'Only Team Lead and CEO accounts can view leave requests' });
    }

    const filter = { employeeId: { $nin: reviewerKeys(reviewer) } };
    if (req.query.status) filter.status = req.query.status;

    const requests = await db.collection('leave_requests')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, requests });
  } catch (err) {
    console.error('Fetch leave requests error:', err.message);
    return res.status(500).json({ error: 'Server error fetching leave requests: ' + err.message });
  }
});

// Approve or reject a request (Team Lead / CEO only, first decision wins)
app.put('/api/leave-requests/:id', async (req, res) => {
  try {
    const { status, reviewerId, comment } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'Approved' or 'Rejected'" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ error: 'Database connection failed' });

    const reviewer = await getReviewer(db, reviewerId);
    if (!reviewer) {
      return res.status(403).json({ error: 'Only Team Lead and CEO accounts can review leave requests' });
    }

    const _id = new mongoose.Types.ObjectId(req.params.id);
    const existing = await db.collection('leave_requests').findOne({ _id });
    if (!existing) return res.status(404).json({ error: 'Leave request not found' });

    if (reviewerKeys(reviewer).includes(String(existing.employeeId))) {
      return res.status(403).json({ error: "You can't review your own leave request" });
    }
    if (existing.status !== 'Pending') {
      return res.status(409).json({
        error: `This request was already ${existing.status.toLowerCase()} by ${existing.reviewedBy || 'another reviewer'}`
      });
    }

    const result = await db.collection('leave_requests').findOneAndUpdate(
      { _id, status: 'Pending' },
      {
        $set: {
          status,
          reviewedBy: reviewer.name || reviewer.id,
          reviewerRole: reviewer.role || 'CEO',
          reviewComment: String(comment || '').trim(),
          reviewedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );

    // MongoDB driver v5 returns { value: doc }, v6+ returns the doc itself
    const updated = result && result.lastErrorObject !== undefined ? result.value : result;
    if (!updated) {
      return res.status(409).json({ error: 'This request was just reviewed by someone else' });
    }

    console.log(`✅ Leave request ${req.params.id} ${status.toLowerCase()} by ${reviewer.name || reviewer.id}`);
    return res.json({ success: true, request: updated });
  } catch (err) {
    console.error('Review leave request error:', err.message);
    return res.status(500).json({ error: 'Server error reviewing leave request: ' + err.message });
  }
});

// ==================== SERVER INITIALIZATION ====================
// ==================== SERVER INITIALIZATION ====================
const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bulletproof backend running live on port ${PORT}`);
});