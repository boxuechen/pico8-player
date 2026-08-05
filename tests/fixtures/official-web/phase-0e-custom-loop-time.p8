pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-owned phase 0e differential probe
--
-- each row records round(time() * 30) at the start of one custom-loop
-- iteration. columns 0..7 are the value's low bits, least-significant first.
-- every logical cell is a 4x4 block. x=60 is the row-marker column and the
-- block at (60,60) is the completion marker.

local samples={}
local sample_count=8

for i=0,sample_count-1 do
 samples[i]=flr(time()*30+0.5)
 flip()
end

cls(0)
for row=0,sample_count-1 do
 local value=samples[row]
 rectfill(60,row*4,63,row*4+3,8)
 for bit=0,7 do
  if value%2==1 then
   rectfill(bit*4,row*4,bit*4+3,row*4+3,7)
  end
  value=flr(value/2)
 end
end
rectfill(60,60,63,63,11)

while true do
 flip()
end
